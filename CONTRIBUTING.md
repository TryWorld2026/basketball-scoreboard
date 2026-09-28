# 贡献指南

欢迎提 Issue 和 PR。改动越小越容易合入。

## 开发环境

```bash
git clone <你的 fork>
cd basketball-scoreboard
npm install
npm run db:migrate:local
npm run dev            # http://127.0.0.1:8787
```

要求 Node 22+（wrangler 部署需要；只跑 `npm test` 的话 Node 18+ 即可，测试不碰云）。部署预览需要 Cloudflare 账号与 `npx wrangler login`，但**跑测试不需要任何云账号**。

## 提交前必须全绿

```bash
npm test
```

七张网分别是主流程冒烟、对抗探针、前端仓库层、双端时钟镜像一致性、移动端静态断言、大屏状态、变异测试。**变异测试是这里的门槛**：它把每处修复逐个还原，要求断言必须变红、且红在该管它的断言上；跑之前还会先确认基线全绿（否则红可能只是基线本来就红，整张表结论失真）。新增修复时，请同时往 `dev/mutate.mjs` 里加对应变异体——否则那条修复等于没被测到。

另外两条硬规矩：

- 测试**变红必须让进程非零退出**。曾出现过攻击探针打印 `ATTACK` 却 `exit 0`，整张网看着在跑、实际不构成门禁。
- 改 `worker/rules.mjs` 的时钟逻辑，`dev/parity.mjs` 会比对 `public/js/clock.js` 的镜像实现；只改一边必红。
- `public/js/clock.js` 里**只服务前端的判定**（如 `periodNextFinishes` 决定要不要弹确认）不往 `worker/rules.mjs` 放镜像副本，而是由 `dev/parity.mjs` 直接拿服务端 `applyAction` 的落库结果反锁——判定和服务端行为不一致时，那条用例会红。

CI（`.github/workflows/test.yml`）会在每次 push 和 PR 上跑：`npm test` 七张内存/静态测试网、独立的 `local-d1` 真实 Worker + 本地 D1 门禁、以及 `ui` 真浏览器旅程门禁；部署走 Cloudflare Workers Builds（实测 Git 集成可能没接上，届时用 `npx wrangler deploy` 手动补），与本仓库的测试门禁互不相干。

**真浏览器门禁**：`npm run test:ui`（先 `npm install` + `npx playwright install chromium`，另起终端跑 `npm run dev`，或用 `UI_BASE_URL` 指向已在跑的实例）。它按 iPhone 视口无头跑完关键旅程并截图到 `.ui-shots/`——本项目一半的 UI 坑只在真浏览器里现形（审计列表渲染出「false」文本节点就是截图才发现的），改 `public/js/views/*` 后请跑一遍。

改动规则引擎时，优先运行 `npm run test:e2e`：它自动迁移本地 D1、启动临时 `wrangler dev`，再跑 35 项真实 SQL 链路，不需要 Cloudflare 凭据，也不碰生产。`node dev/d1-check.mjs <remoteBaseUrl>` 默认拒绝远程写探针，只有设置 `D1_CHECK_ALLOW_REMOTE=1` 才允许。

## 代码结构约定

| 位置 | 职责 | 约束 |
|---|---|---|
| `worker/rules.mjs` | 规则引擎 | **纯函数，禁止 I/O**。时钟推算与 `public/js/clock.js` 是镜像实现，改一处必须同步另一处（`dev/parity.mjs` 会比对） |
| `worker/handler.mjs` | HTTP 与并发 | 只依赖注入的 `store` 接口，不要在这里写 SQL。限流器可注入（`limiters` 参数），测试用注入的紧凑上限，不靠默认值。**写路径（apply）必须先过 `authorizeActor`：房间码只给读，控制凭证才给写；老行无凭证一律 fail closed。每一次真落地还要落一条操作审计（`action_log`），和状态更新同一个批处理** |
| `worker/ratelimit.mjs` | 限流 | 进程内计数、只统计失败请求；不得统计正常轮询（会误伤 1 秒刷新） |
| `worker/store-d1.mjs` | 数据适配 | 换数据库只需重写这一层，保持 `getGame / insertGame / casUpdateGame / casUpdateGameWithReceipt / getLog / listLiveGames / reissueController / deleteStaleSetup / deleteAbandoned` 语义；审计写入必须和状态更新在同一个批处理里（CAS 输了就不记） |
| `public/js/clock.js` | 前端时钟/节次判定 | `derive*` 必须是 `worker/rules.mjs` 的镜像；纯前端判定（如 `periodNextFinishes`）由 `dev/parity.mjs` 拿服务端落库结果反锁 |
| `public/js/views/control.js` | 控制端 | 不可逆动作（结束比赛、重开、末节跳节）一律先 `confirm`；自动 `clock_zero` / `shot_reset` 靠 `zeroHandled` 去重，每个归零瞬间只发一次 |
| `public/js/` | 前端 | 原生 ES module，不引入框架和构建步骤；DOM 一律用 `textContent` / `setAttribute`，不要 `innerHTML` 拼接 |
| `dev/` | 测试脚手架 | `dev/*.mjs` 逻辑/静态测试跑在内存假库上；`npm run test:e2e` 另起本地 Wrangler + D1 真链路；不需要云账号 |

## 设计原则

这个产品的价值押在**双端同步**和**大屏可读性**上，不押在功能数量上。提新功能前先问：它是否让记分员在现场更快、或让大屏更远看得更清？

历史上被明确拒绝过的方向（不要再提，除非有强理由）：账号体系、赛事报名与赛程、球员完整技术统计、WebSocket、多步撤销历史。理由见 `docs/plans/basketball-scoreboard-design.md`。

## 提交信息

用 conventional commits，正文说清"为什么"而不是"改了什么"：

```
fix: 休息期记分串节

节间休息时 period 已 +1，此时按 +3 会静默记进下一节流水。
记分/记犯规改为仅在 clock.mode === 'game' 时接受。
```
