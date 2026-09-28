// 真浏览器验证：无头 Chromium 按手机视口跑一遍关键用户旅程。
// 存在的理由：CI 里没有 iPhone，而本项目一半的坑只在真浏览器里现形
// ——审计列表渲染出「false」文本节点、找回码区块不显示、大屏不同步，
// 全是静态断言和 HTTP 探针抓不到、截图才看得见的。
// 运行：先起 wrangler dev，再 node dev/ui-check.mjs（或 npm run ui:check）。
// 环境变量：UI_BASE_URL 指定地址（默认 http://127.0.0.1:8787）；
//           UI_KEEP_BROWSER=1 保留现场（调试用）。
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const BASE = (process.env.UI_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const SHOTS = new URL('../.ui-shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

let pass = 0; let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`FAIL ${name} ${detail}`); }
};

// @playwright/test 是 devDependency：npm test 不依赖它，只有本脚本用。
let chromium;
try {
  chromium = createRequire(import.meta.url)('@playwright/test').chromium;
} catch {
  console.error('未安装 @playwright/test——它是 devDependency，先 npm install；');
  console.error('浏览器二进制首次使用前还要 npx playwright install chromium。');
  process.exit(2);
}

mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: true });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); // iPhone 尺寸
  const pageErrors = [];
  const onPage = (p) => p.on('pageerror', (e) => pageErrors.push(e.message));
  onPage(await ctx.newPage());
  const pages = ctx.pages();
  const open = async (url) => { const p = await ctx.newPage(); onPage(p); await p.goto(url, { waitUntil: 'networkidle' }); return p; };

  try {
    // 1) 建赛
    const home = pages[0];
    await home.goto(BASE, { waitUntil: 'networkidle' });
    await home.getByLabel('主队名').fill('计算机1班');
    await home.getByLabel('客队名').fill('软件2班');
    await home.getByRole('button', { name: '创建比赛 →' }).click();
    await home.waitForURL(/\/room\/[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/, { timeout: 20000 });
    const code = home.url().match(/\/room\/(\w{4})$/)[1];
    ok('建赛成功并跳转房间页', !!code, home.url());
    await shot(home, '01-room');

    // 2) 房间页：找回码区块（手机丢了唯一的救援）
    await home.waitForSelector('.recovery-box', { timeout: 10000 });
    const recovery = (await home.locator('.recovery-code').textContent()).trim();
    ok('房间页展示控制找回码', /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/.test(recovery), recovery);

    // 3) 控制端：记分（LED 是纯 DOM 七段管，没有文本——数字段数即位数）
    const control = await open(`${BASE}/room/${code}/control`);
    await control.waitForSelector('.btn-score', { timeout: 10000 });
    await control.getByRole('button', { name: '计算机1班 加2分' }).click();
    await control.getByRole('button', { name: '计算机1班 加3分' }).click();
    await control.getByRole('button', { name: '软件2班 加2分' }).click();
    await control.getByRole('button', { name: '犯规+1' }).first().click();
    await control.waitForTimeout(1200);
    const digits = await control.locator('.team-panel').first().locator('.led-score .led-digit').count();
    const state = await (await fetch(`${BASE}/api/game?action=get&code=${code}`)).json();
    ok('控制端记分落地（服务端 5:2，犯规 1）',
      digits === 1 && state.state.teams[0].score === 5 && state.state.teams[1].score === 2 && state.state.teams[0].fouls === 1,
      `LED 位数=${digits} 比分=${state.state.teams[0].score}:${state.state.teams[1].score}`);
    await shot(control, '02-control');

    // 4) 大屏：只读同步
    const display = await open(`${BASE}/room/${code}/display`);
    await display.waitForTimeout(1500);
    const bigDigits = await display.locator('.d-center .led-big').first().locator('.led-digit').count();
    ok('大屏同步到主队得分', bigDigits === digits, `大屏位数=${bigDigits} 控制端位数=${digits}`);
    await shot(display, '03-display');

    // 5) 数据卡：操作记录面板（吵架时的核对面）
    const card = await open(`${BASE}/room/${code}/card`);
    await card.waitForSelector('.card-log-item', { timeout: 10000 });
    const items = await card.locator('.card-log-item').allTextContents();
    const body = (await card.locator('.card-log').textContent()) || '';
    ok('操作记录逐条可读（动作 + 前后比分 + 操作者指纹）', items.length === 4 && /5:2 → 5:2/.test(body), JSON.stringify(items));
    ok('操作记录里没有渲染出「false」之类脏文本', !/\bfalse\b/.test(body), body.slice(-80));
    await shot(card, '04-card');

    // 6) 补发：错码报错、对码换锁
    const recover = await open(BASE);
    await recover.getByLabel('房间码（找回控制权）').fill(code);
    await recover.getByLabel('控制找回码').fill('AAAA-BBBB');
    await recover.getByRole('button', { name: '换发控制权' }).click();
    await recover.waitForTimeout(800);
    const errText = (await recover.locator('.form-error').last().textContent()).trim();
    ok('错误找回码给出人话提示', /找回码不正确/.test(errText), errText);
    await recover.getByLabel('控制找回码').fill(recovery);
    await recover.getByRole('button', { name: '换发控制权' }).click();
    await recover.waitForURL(new RegExp(`/room/${code}`), { timeout: 20000 });
    const rotated = (await recover.locator('.recovery-code').textContent()).trim();
    ok('换发成功且找回码轮换（旧码失效）', rotated !== recovery && /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-/.test(rotated), rotated);
    await shot(recover, '05-recovered');

    // 7) 全新设备（无凭证）：控制端说清怎么救，而不是让记分员对着 toast 猜
    const fresh = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const nocred = await fresh.newPage();
    await nocred.goto(`${BASE}/room/${code}/control`, { waitUntil: 'networkidle' });
    await nocred.waitForTimeout(600);
    ok('无凭证设备打开控制端有常驻说明', (await nocred.locator('.cred-err').count()) > 0);
    await nocred.screenshot({ path: `${SHOTS}06-nocred.png`, fullPage: true });

    ok('全程没有未捕获的页面异常', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    await browser.close();
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}（截图在 .ui-shots/）`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FLOW-ERR:', e.message); process.exit(1); });
