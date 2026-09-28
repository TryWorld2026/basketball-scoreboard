// 本地 D1 全链路门禁：真 SQL、真 Worker、真 HTTP——不碰云端、不需要任何凭据。
// 流程：本地迁移 → 起 wrangler dev → 等就绪 → 打 dev/d1-check.mjs → 收摊。
// 用法：npm run test:e2e
// 环境变量：E2E_PORT 换端口（默认 8799，避开常用 8787/8788）。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const R = (f) => fileURLToPath(new URL(f, import.meta.url));
const PORT = Number(process.env.E2E_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT_MS = 90_000;
const WRANGLER = R('../node_modules/wrangler/bin/wrangler.js');
const ENV = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runWrangler(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WRANGLER, ...args], { env: ENV, stdio: 'inherit', ...options });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function waitReady() {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${BASE}/`);
      if (response.ok) return true;
    } catch { /* workerd 还没起来 */ }
    if (Date.now() - started > READY_TIMEOUT_MS) return false;
    await sleep(500);
  }
}

console.log('— 本地 D1 迁移 —');
if (await runWrangler(['d1', 'migrations', 'apply', 'scoreboard-db', '--local']) !== 0) {
  console.error('本地迁移失败，e2e 中止');
  process.exit(1);
}

console.log(`\n— 启动 wrangler dev :${PORT} —`);
let devLog = '';
const dev = spawn(process.execPath, [WRANGLER, 'dev', '--port', String(PORT), '--ip', '127.0.0.1'], {
  env: ENV,
  stdio: ['ignore', 'pipe', 'pipe'],
});
dev.stdout.on('data', (chunk) => { devLog += chunk.toString(); });
dev.stderr.on('data', (chunk) => { devLog += chunk.toString(); });

let stopped = false;
function stopDev() {
  if (stopped || dev.exitCode !== null || dev.signalCode) return;
  stopped = true;
  if (process.platform === 'win32') {
    // workerd 是子进程树，Windows 上必须整树杀，否则端口会占着导致下次运行冲突。
    spawn('taskkill', ['/pid', String(dev.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    dev.kill('SIGTERM');
  }
}
process.on('exit', stopDev);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { stopDev(); process.exit(130); });
}

// ---------- cron 到点推进：真实 SQL + 真 scheduled 触发器 ----------
// 造一个「时钟已归零」的局（用 wrangler d1 execute 直接改本地库，模拟时钟耗尽），
// 触发 wrangler dev 的 /__scheduled 测试端点，验证服务端不等记分员手机在线也能推进。
async function cronCheck() {
  const post = async (action, body) => fetch(`${BASE}/api/game?action=${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

  const created = await post('create', {
    teams: [{ name: 'Cron甲班', color: '#1E4FD8' }, { name: 'Cron乙班', color: '#E11D2E' }],
    config: { periods: 2, periodMinutes: 1, breakSeconds: 20 },
  });
  const code = created.code;
  await fetch(`${BASE}/api/game?action=apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${created.controlToken}` },
    body: JSON.stringify({ code, version: created.version, action: { type: 'clock_start' } }),
  });

  // 把这一刻的时钟改成「早归零」：since 推到 2020 年、remainingMs 归零
  const sql = `update games set state = json_set(json_set(state, '$.clock.since', '2020-01-01T00:00:00.000Z'), '$.clock.remainingMs', 0) where code = '${code}'`;
  console.log('\n— 服务端到点推进：cron 真实链路 —');
  if (await runWrangler(['d1', 'execute', 'scoreboard-db', '--local', '--command', sql]) !== 0) {
    console.error('FAIL  cron 播种失败（wrangler d1 execute）');
    result = 1;
    return;
  }

  // wrangler dev 的 cron 测试端点是 /cdn-cgi/local/scheduled（不是 /__scheduled，
  // 那个只会命中 SPA 回退返回 index.html——第一版就踩了这个坑）。
  const fired = await fetch(`${BASE}/cdn-cgi/local/scheduled?cron=${encodeURIComponent('* * * * *')}`);
  if (!fired.ok) {
    console.error(`FAIL  cron 测试端点返回 ${fired.status}`);
    result = 1;
    return;
  }
  // scheduled 里是 waitUntil 的异步推进：响应先回、落地稍后，轮询等它落库
  let after = null;
  for (let i = 0; i < 12; i += 1) {
    await sleep(500);
    after = await fetch(`${BASE}/api/game?action=get&code=${code}`).then((r) => r.json());
    if (after.state?.clock?.mode === 'break') break;
  }
  const log = await fetch(`${BASE}/api/game?action=log&code=${code}`).then((r) => r.json());
  const okAdvance = after.state?.clock?.mode === 'break';
  const okAudit = log.entries?.[0]?.actor === 'cron';
  if (!okAdvance || !okAudit) {
    console.error(`FAIL  cron 到点推进：mode=${after.state?.clock?.mode} actor=${log.entries?.[0]?.actor}`);
    result = 1;
    return;
  }
  console.log('  ok   cron 到点推进（归零局 → __scheduled → 进节间，审计 actor=cron）');
}

let result = 1;
try {
  if (!(await waitReady())) {
    console.error(`wrangler dev 在 ${READY_TIMEOUT_MS / 1000}s 内没有就绪。日志尾部：\n${devLog.slice(-3000)}`);
  } else {
    console.log('\n— 打真实链路：d1-check —\n');
    result = await new Promise((resolve) => {
      const check = spawn(process.execPath, [R('d1-check.mjs'), BASE], { stdio: 'inherit' });
      check.on('exit', (code) => resolve(code ?? 1));
    });
    if (result === 0) await cronCheck();
  }
} finally {
  stopDev();
  await sleep(250);
}

console.log(`\ne2e 结果：${result === 0 ? '通过' : '失败'}`);
process.exit(result);
