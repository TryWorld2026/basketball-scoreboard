// 大屏状态测试：displayPhase 的逐场景判定 + display.js「照判定画」的静态断言。
// 大屏的第一性能不仅是"三米外看清比分"，还有"现在放的画面是对的"：
// 房间不存在时不能假装等待开赛（打错的码会装成还没开始的比赛），
// 信号弱时不能继续推服务端已经不认的时间（本地推 = 假时间）。
// 运行：node dev/display.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { displayPhase } from '../public/js/clock.js';

const R = (f) => fileURLToPath(new URL(f, import.meta.url));
const DISPLAY_RAW = readFileSync(R('../public/js/views/display.js'), 'utf8');
// 剥掉注释再断言——mobile.mjs 踩过的坑：注释里写着"必须走 X"，真调用删光断言照样绿
const stripJs = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const DISPLAY = stripJs(DISPLAY_RAW);

let pass = 0; let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name} ${detail}`); }
};

// ---------- 1. displayPhase 逐场景 ----------
console.log('— 大屏画面判定 —');
const fakeStore = (over = {}) => ({
  fatal: null,
  loading: false,
  state: { status: 'live' },
  status: 'live',
  stale: () => false,
  ...over,
});
ok('房间不存在 → error（不假装等待开赛）',
  displayPhase(fakeStore({ fatal: { message: '房间不存在' }, state: null, status: 'setup' })) === 'error',
  '打错的房间码不能显示成"等待开赛"');
ok('首次加载中 → loading', displayPhase(fakeStore({ loading: true, state: null, status: 'setup' })) === 'loading');
ok('没加载完且不在 loading → reconnecting', displayPhase(fakeStore({ loading: false, state: null, status: 'setup' })) === 'reconnecting');
ok('setup → 等待开赛画面', displayPhase(fakeStore({ state: { status: 'setup' }, status: 'setup' })) === 'setup');
ok('finished → 终局画面', displayPhase(fakeStore({ state: { status: 'finished' }, status: 'finished' })) === 'finished');
ok('正常直播 → live', displayPhase(fakeStore()) === 'live');
ok('超过 3 秒无响应 → stale', displayPhase(fakeStore({ stale: () => true })) === 'stale');
ok('setup 期间断网仍是 setup（等待画面 + 信号弱角标，不假装在打）',
  displayPhase(fakeStore({ state: { status: 'setup' }, status: 'setup', stale: () => true })) === 'setup');

// ---------- 2. display.js 照判定画（静态断言，CI 里没有大屏） ----------
console.log('\n— 大屏渲染接线 —');
ok('paint 以 displayPhase 为总开关', DISPLAY.includes('const phase = displayPhase(store);'));
ok('房间不存在有专属错误面板', DISPLAY.includes("class: 'd-wait d-err'") && DISPLAY.includes('房间不存在或已归档'));
ok('加载中/重连有明确文案', DISPLAY.includes('连接中') && DISPLAY.includes('信号弱，正在重连'));
ok('时钟走 store.displayClock()（stale 冻结版）', DISPLAY.includes('store.displayClock()'));
ok('24 秒走 store.displayShot()（stale 冻结版）', DISPLAY.includes('store.displayShot()'));
ok('不再直接用 store.clock() 推时间（那会在 stale 时播假时间）', !/store\.clock\(\)/.test(DISPLAY));
ok('没有"没状态就静默 return"的空显示分支', !/if \(!s\) return;/.test(DISPLAY));
ok('归零蜂鸣只认 d.zero（冻结期 zero 恒为 false，stale 不误报）', DISPLAY.includes('if (d.zero && !zeroHandled)'));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) { console.log('失败项见上'); }
process.exit(fail ? 1 : 0);
