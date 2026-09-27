# 篮球计分板 · Basketball Scoreboard

> 校园班赛的官方记分牌：手机当遥控器，任何一块屏幕当大屏，打完自动出一张能甩进班群的数据卡。

**在线使用**：https://score.tryworld.com.cn （无需注册，打开即是建赛页）

> `*.workers.dev` 子域在国内网络下会被 DNS 污染、间歇性不可达，所以线上走自定义域名 `score.tryworld.com.cn`（Cloudflare zone 权威 DNS）。原始的 workers.dev 地址仍可用：https://basketball-scoreboard.1822520752.workers.dev

![license](https://img.shields.io/badge/license-MIT-green) ![runtime](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1-orange) ![build](https://img.shields.io/badge/build-no%20bundler-lightgrey)

---

## 为什么做这个

班赛现场的真实痛点不是"没有计分 App"，而是：**比分记在某个人的手机里，打完吵架，第四节最后两分钟没人记得清犯规**。

所以这个项目的全部价值押在两件事上，而不是功能数量：

1. **双端同步** —— 记分员用手机点，全场看大屏，谁都不用抢那台手机
2. **大屏可读性** —— 三米外一眼看清比分，这是计分板的第一性能

## 核心特性

| | |
|---|---|
| 📱 **手机遥控 + 大屏展示** | 4 位房间码即分享即加入，扫码或点链接都行，**没有注册登录** |
| 📺 **转播风格大屏** | 纯 CSS 手绘七段数码管（零字体、零图片），界面由两队队色生成 |
| ⏱ **时钟不丢** | 服务端只存"正在走、从某时刻起剩多少"，刷新 / 换设备 / 断网重连后时钟连续 |
| 🛡 **不丢分也不双计** | 客户端只发"意图"，服务端原子算状态；两个记分员同时按分都算；响应丢失后补发只记一次 |
| 🏆 **赛后数据卡** | 每节流水、得分王、三分/两分/罚球/犯规对比，**一键存 1080×1440 PNG**（纯前端 canvas，不过服务器） |
| 📴 **户外弱网可用** | 断网时操作排队，恢复后按序补发；大屏显示"信号弱·最后更新 HH:MM"而不是假时间 |
| ⌨ **笔记本也能当遥控器** | `空格` 开始/暂停、`Z` 撤销、`A/S/D` 与 `J/K/L` 主队/客队 1/2/3 分、`R` 重置 24 秒、`P` 交换球权 |

## 快速开始

```bash
npm install                 # 只装 wrangler，运行时零依赖
npm run db:migrate:local    # 本地 D1 建表
npm run dev                 # http://127.0.0.1:8787
```

打开后点「新建比赛」→ 填两队队名与队色 → 再开一个标签页访问 `/room/<房间码>/display` 就能看到双端同步。

> **不想接 Cloudflare？** `npm test` 五张测试网跑在内存假库上，不需要任何云账号或网络。

## 测试

```bash
npm test
```

| 套件 | 覆盖 | 规模 |
|---|---|---|
| `dev/smoke.mjs` | 主流程：建赛、计分、撤销、犯规、节次、加时、锁定、校验、24 秒链路、全场累计犯规 | 34 项 |
| `dev/attack.mjs` | 对抗探针：幂等、并发丢分、跳节滥用、类型强制、不可逆性、无界增长、注入面、协议健壮性、撤销吞时间、限流、房间清理 | 86 项 |
| `dev/store.mjs` | 前端仓库层：断网排队、按序补发、nonce、乱序响应丢弃、冲突刷新、脏队列降级 | 22 项 |
| `dev/parity.mjs` | **双端时钟镜像一致性**：`worker/rules.mjs` 与 `public/js/clock.js` 两份 `derive*` 逐场景必须相等；并用服务端 `applyAction` 的真实落库结果反锁「下一节」终局判定 | 49 项 |
| `dev/mutate.mjs` | **变异测试**：把每处修复逐个还原，断言测试网必须变红在该管它的断言上；跑前先验证基线全绿 | 25 个变异体 |

变异测试是这里的关键——它证明断言不是空的。本项目实测中它抓出过一条空断言（只验了"平局会进加时"，从没验"分出胜负必须结束"），补探针后才闭上。
它同时逼出过一条真问题：攻击探针一度在输出里打印 `ATTACK` 却 `exit 0`，整张网看着在跑、实际不构成门禁。

```bash
node dev/d1-check.mjs https://<你的域名>   # 打真实 Worker + D1 SQL 的链路验证（26 项）
```

## 架构

```
浏览器（原生 ES module，无框架无构建）
  ├─ /                    建赛 · 加入
  ├─ /room/:code          房间码 + 二维码
  ├─ /room/:code/control  控制端（手机）
  ├─ /room/:code/display  大屏（只读）
  └─ /room/:code/card     数据卡（canvas 导出 PNG）
        │
        │  同源 /api/game?action=get|create|apply
        ▼
Cloudflare Worker
  worker/handler.mjs   参数校验 · 意图白名单 · 版本号 CAS 重放 · 失败限流
  worker/rules.mjs     规则引擎（纯函数，比分/时钟/犯规/节次唯一事实来源）
  worker/ratelimit.mjs 进程内滑动窗口限流（只挡失败请求，不挡正常轮询）
  worker/store-d1.mjs  D1 适配器（换库只动这一层）
        ▼
Cloudflare D1   games 表：一场比赛一行，整场状态一个 JSON + version
```

**三条撑起其余一切的设计决定：**

1. **客户端只发"意图"，服务端算状态。** 手机发的是"红队 +2"，不是"新比分=48"。否则两个人同时按 +1 必然丢一个，而且谁能改比分这事必须握在服务端。
2. **时钟不跑在服务端。** 只存 `running + since + remainingMs`，任何设备打开都能自己推算当前剩余——刷新、换手机、断网重连，时钟都不丢。
3. **1 秒轮询，不做 WebSocket。** 比分晚一秒出现毫无感知（真实记分牌本来就是裁判吹哨后才变），换来零长连接基础设施、断线自动恢复。

完整设计推演（含逐条决策理由与异常状态矩阵）见 [`docs/plans/basketball-scoreboard-design.md`](docs/plans/basketball-scoreboard-design.md)。

## 规则默认值

4 节 × 10 分钟、单节团队犯规满 5 次起罚球、每队 3 次暂停、24 秒进攻时限默认关、末节平局自动进加时、时钟归零自动进节间休息并蜂鸣。全部建赛时可改。撤销只撤最近一步——误按都是刚发生的，多步历史反而诱发"回到五分钟前"的混乱。

开启 24 秒后：开球即走表，**进球归满并继续走**（不是停表），暂停/停表同步停；归零蜂鸣并自动重置，球权用「⇄ 交换球权」手动切。
撤销会同时把时钟停在动作发生那一刻（不自动继续走）——这是刻意的：让撤销悄悄吞掉停表时间，比多按一次「开始」危险得多。

「下一节 ▶」在**末节已分胜负**时会直接终局并锁定比分，因此这一下和「结束比赛」一样要先确认（平局会进加时、节间休息中只是提前结束休息，都不问）。 Clock自然走完导致的终局没有确认可弹，那是比赛正常打完。

## 部署到自己的 Cloudflare

```bash
npx wrangler d1 create scoreboard-db          # 把返回的 database_id 填进 wrangler.jsonc
npx wrangler d1 migrations apply scoreboard-db --remote
npx wrangler deploy
```

### 推送即自动部署

用 Cloudflare 原生的 **Workers Builds** 接 GitHub：Worker 详情页 → Settings → Builds →
Connect to Git，选本仓库、生产分支 `main`。此后每次 push 到 `main` 自动构建并部署，
**GitHub 侧不需要存任何凭据**（Cloudflare 自己管），PR 还会自动带上预览链接。

`.github/workflows/test.yml` 只负责把五张测试网当合并门禁跑一遍，不参与部署。
建库和迁移仍按上面的命令手动执行——Workers Builds 不会替你跑 D1 迁移。

## 技术栈

Cloudflare Workers · D1 · 原生 ES Module · Web Audio（合成蜂鸣，无音频文件）· WakeLock（防锁屏）· Canvas（数据卡导出）· wrangler

**运行时零依赖**：前端没有框架和构建步骤，后端没有第三方包。

## 已知边界

- **房间码即访问能力**。没有账号体系，拿到 4 位码就能改比分——这是班赛的刻意取舍（现场要的是快，不是权限）。要用于正式比赛，需要加裁判身份与签名写路径。
- **限流是尽力而为，不是硬保证**。Workers 没有跨请求共享内存，计数器按 isolate 独立：能显著抬高"遍历 4 位房间码"的成本，挡不住分布式枚举。只统计失败请求（房间不存在 / 参数非法 / 冲突），正常 1 秒轮询不计次、不会被误伤。
- 已结束的比赛永久留在库里（数据卡链接要能长期打开）；"筹建中但没打"的房间、以及超过 7 天没有任何写入的半途放弃局，在下次建赛时顺带清理（平台无 cron）。
- 撤销只撤最近一步，且撤销会同时停表——这是为了不让时间在记分员看不见的地方被消耗掉。
- 数据卡存图依赖浏览器 canvas 导出中文字体，个别环境失败时会提示改用截图。

## 贡献

先看 [CONTRIBUTING.md](CONTRIBUTING.md)。改规则引擎请务必备好测试。

## 许可

[MIT](LICENSE)
