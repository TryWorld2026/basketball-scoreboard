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
  }
} finally {
  stopDev();
  await sleep(250);
}

console.log(`\ne2e 结果：${result === 0 ? '通过' : '失败'}`);
process.exit(result);
