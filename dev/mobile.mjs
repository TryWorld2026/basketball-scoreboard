// 移动端兼容性测试：把「手机上真出过/会出的问题」钉死在静态断言上。
// 这些问题在自动化里表现不出来——测试跑在 Node 里、CI 里没有 iPhone——
// 只有把「修好的样子」写成断言，才不会在下一次改版里悄悄退回去。
// 运行：node dev/mobile.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const R = (f) => fileURLToPath(new URL(f, import.meta.url));
const CSS = readFileSync(R('../public/styles.css'), 'utf8');
const CARD_RAW = readFileSync(R('../public/js/views/card.js'), 'utf8');
const CONTROL_RAW = readFileSync(R('../public/js/views/control.js'), 'utf8');
const INDEX = readFileSync(R('../public/index.html'), 'utf8');

// 剥掉注释再断言。card.js 里有一句「必须走 navigator.share({ files })」的注释，
// 不剥的话真调用被删光、断言照样绿——那测试就成了摆设。
// [^:] 兜底 http:// 这种 URL 里的双斜杠。
const stripJs = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const CARD = stripJs(CARD_RAW);
const CONTROL = stripJs(CONTROL_RAW);

let pass = 0; let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name} ${extra}`); }
};

// ---------- 极简 CSS 解析 ----------
// 只需要「选择器 + 声明 + 所在 @ 上下文」，不做特异性——
// 断言关心的是「这个选择器有没有写够」，不是层叠结果。
function parseRules(css, ancestors = []) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, ''); // 注释里的话不算数
  const rules = [];
  let i = 0;
  while (i < clean.length) {
    const open = clean.indexOf('{', i);
    if (open < 0) break;
    const selector = clean.slice(i, open).trim().replace(/\s+/g, ' ');
    if (selector.startsWith('@')) {
      let depth = 1; let j = open + 1;
      while (j < clean.length && depth > 0) {
        if (clean[j] === '{') depth += 1;
        else if (clean[j] === '}') depth -= 1;
        j += 1;
      }
      rules.push(...parseRules(clean.slice(open + 1, j - 1), [...ancestors, selector]));
      i = j;
      continue;
    }
    const close = clean.indexOf('}', open);
    if (close < 0) break;
    rules.push({ selector, body: clean.slice(open + 1, close), ancestors: [...ancestors] });
    i = close + 1;
  }
  return rules;
}

function decls(body) {
  return body.split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const k = d.indexOf(':');
      if (k < 0) return null;
      return { prop: d.slice(0, k).trim(), value: d.slice(k + 1).trim() };
    })
    .filter(Boolean);
}

// px / rem → px；dvh、vh、auto 之类无法静态判定的返回 null
function pxOf(value) {
  const m = /^(\d+(?:\.\d+)?)(px|rem)$/.exec(value.trim());
  if (!m) return null;
  return m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1]);
}

const RULES = parseRules(CSS);

// ---------- 1. 触控目标 ----------
// 苹果 HIG 44pt / 安卓 48dp。手机上指尖落在哪是纯运气，
// 低于这个值就等于「记分员盯着球场盲点时会点错人」。
const INTERACTIVE = [
  'button', 'a[', '.chip', '.ghost', '.primary', '.danger', '.btn-score',
  '.clock-btn', '.icon-btn', '.swatch', '.check', '.back', '.status-link',
  '.inp', '.big', '.small',
];
const isInteractive = (sel) => INTERACTIVE.some((p) => sel.includes(p));

console.log('— 触控目标 ≥ 44px —');
const interactiveMinHeights = RULES
  .filter((r) => isInteractive(r.selector))
  .flatMap((r) => decls(r.body).map((d) => ({ ...d, selector: r.selector })))
  .filter((d) => d.prop === 'min-height')
  .map((d) => ({ selector: d.selector, raw: d.value, px: pxOf(d.value) }))
  .filter((d) => d.px !== null);

check('找到了交互控件的 min-height 声明（解析器没跑偏）', interactiveMinHeights.length >= 8, String(interactiveMinHeights.length));
for (const d of interactiveMinHeights) {
  check(`${d.selector} 命中区 ≥ 44px`, d.px >= 44, `实际 ${d.raw}`);
}

const chip = RULES.find((r) => /^\s*\.chip\s*$/.test(r.selector));
const chipMin = chip ? decls(chip.body).find((d) => d.prop === 'min-height') : null;
check('球员得分按钮 .chip 命中区不小于 44px', !!chipMin && pxOf(chipMin.value) >= 44, chipMin ? chipMin.value : '缺少 min-height');

// .swatch 用 width/height 定尺寸，且按钮自身必须是方的：
// 一旦加回 border-radius:50%，命中区就削成圆，四角白丢。
const swatch = RULES.find((r) => r.selector.trim() === '.swatch');
const swatchDecl = swatch ? decls(swatch.body) : [];
const swW = swatchDecl.find((d) => d.prop === 'width');
const swH = swatchDecl.find((d) => d.prop === 'height');
const swRadius = swatchDecl.find((d) => d.prop === 'border-radius');
check('.swatch 命中区 44×44', !!swW && !!swH && pxOf(swW.value) >= 44 && pxOf(swH.value) >= 44, swatchDecl.map((d) => `${d.prop}:${d.value}`).join(' '));
check('.swatch 不加 border-radius:50%（否则四角点不到）', !swRadius, swatchDecl.map((d) => `${d.prop}:${d.value}`).join(' '));

// .back 是链接，原来是 17px 高的行内文字
const back = RULES.find((r) => r.selector.includes('.back'));
const backMin = back ? decls(back.body).find((d) => d.prop === 'min-height') : null;
check('返回链接 .back 命中区 ≥ 44px', !!backMin && pxOf(backMin.value) >= 44, backMin ? backMin.value : '缺少 min-height');

// ---------- 2. color-mix 一律要有兜底 ----------
// color-mix 要 iOS 16.2+。不支持时浏览器丢掉整条声明，
// 所以必须先写一条不含 color-mix 的同属性值垫底，否则是「整块消失」而不是「退化」。
console.log('— color-mix 兜底 —');
const covers = (pre, target) => pre === target || target.startsWith(`${pre}-`);
const guarded = (r) => r.ancestors.some((a) => a.startsWith('@supports') && a.includes('color-mix'));
const badColorMix = [];
for (const r of RULES) {
  if (guarded(r)) continue; // 被 @supports 明确圈住，本来就只在支持时生效
  const list = decls(r.body);
  for (let k = 0; k < list.length; k += 1) {
    if (!list[k].value.includes('color-mix(')) continue;
    const hasFallback = list.slice(0, k).some((prev) => covers(prev.prop, list[k].prop) && !prev.value.includes('color-mix('));
    if (!hasFallback) badColorMix.push(`${r.selector} { ${list[k].prop}: ${list[k].value.slice(0, 60)} }`);
  }
}
check('color-mix 一律要有无 color-mix 的兜底声明', badColorMix.length === 0, badColorMix.join(' | '));
check('@supports 包住了被保护的 color-mix 规则', RULES.some((r) => r.ancestors.some((a) => a.startsWith('@supports') && a.includes('color-mix'))));

// ---------- 3. backdrop-filter 要带 -webkit- ----------
// iOS Safari 18 以下只认带前缀的版本，不带就等于没模糊。
console.log('— backdrop-filter —');
const rulesWithBlur = RULES.filter((r) => decls(r.body).some((d) => d.prop === 'backdrop-filter'));
check('页面用了 backdrop-filter', rulesWithBlur.length >= 1, String(rulesWithBlur.length));
for (const r of rulesWithBlur) {
  const props = decls(r.body).map((d) => d.prop);
  check(`${r.selector} 同时声明 -webkit-backdrop-filter`, props.includes('-webkit-backdrop-filter'), props.join(','));
}

// ---------- 4. 关掉双击缩放，保留捏合 ----------
console.log('— 触摸行为 —');
check('body 设置 touch-action: manipulation（连点 +1/+2/+3 不触发双击缩放）', /touch-action:\s*manipulation/.test(CSS));
check('没有锁死缩放（user-scalable=no / maximum-scale）', !/user-scalable\s*=\s*no/i.test(INDEX) && !/maximum-scale/i.test(INDEX));

// ---------- 5. 视口 ---------- 
console.log('— 视口 —');
check('viewport 带 viewport-fit=cover（安全区 inset 才生效）', /viewport-fit=cover/.test(INDEX));
check('viewport 有 width=device-width', /width=device-width/.test(INDEX));

// ---------- 6. 数据卡保存：iOS 走分享面板 ----------
// iOS Safari 至今不认 <a download>（WebKit bug 167341 仍是 OPEN），
// iPhone 上只存得下「一张图 + 长按保存」。必须走 navigator.share({files})。
console.log('— 数据卡保存 —');
check('保存走 navigator.share（iOS 分享面板，「存储图像」进相册）', /navigator\.share\(/.test(CARD));
check('先用 navigator.canShare 探测再决定走哪条路', /navigator\.canShare\(/.test(CARD));
check('提前把 File 备好（share 必须同步发生在用户手势里）', /new File\(\[blob\]/.test(CARD));
check('桌面端保留 <a download> 兜底', /a\.download\s*=/.test(CARD));
check('用户取消分享不算错误（不吞 AbortError 做假提示）', /\.catch\(\(\)\s*=>\s*\{[^}]*\}\)/.test(CARD));

// ---------- 7. 赛后操作记录接线 ----------
// 审计的源头在服务端（attack [19] 锁行为），这里锁「数据卡页真的去读、真的渲染、
// 按版本变化才拉」——服务端记了却没人看的审计，防不了吵架。
console.log('— 赛后操作记录接线 —');
check('数据卡页请求 action=log 并带上房间码', /action=log&code=\$\{encodeURIComponent\(code\)\}/.test(CARD), 'card.js 没有按房间码请求 action=log');
check('渲染四条审计字段（时间/动作/前后比分/操作者指纹）',
  /log-time/.test(CARD) && /log-act/.test(CARD) && /log-score/.test(CARD) && /log-actor/.test(CARD));
check('按版本变化才拉审计（不跟着 3 秒轮询反复请求）', /version !== logVersion/.test(CARD));
check('读不到审计不影响数据卡本身（静默降级）', /catch \{ logBox\.hidden = true; \}/.test(CARD));

// ---------- 8. 笔记本当遥控器：系统快捷键不误记分 ----------
// Ctrl+A / ⌘+S 是系统快捷键。不过滤修饰键的话，
// 记分员在笔记本上全选文本都能给主队加一分。
console.log('— 快捷键修饰键 —');
check('Ctrl/Meta/Alt 组合键不当记分动作', /ctrlKey \|\| e\.metaKey \|\| e\.altKey/.test(CONTROL), 'control.js 不过滤修饰键');

console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
