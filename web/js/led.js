// 纯 CSS 七段数码管。零字体文件、零图片，任意分辨率清晰。

const ON = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
  '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcfgd',
  '-': 'g', ' ': '', A: 'abcdefg', B: 'fgedc', O: 'abcdef',
};
const ORDER = ['g', 'f', 'e', 'd', 'c', 'b', 'a']; // DOM 顺序：a 最后（z 栈叠角更自然）

function buildDigit(ch) {
  const wrap = document.createElement('span');
  wrap.className = 'led-digit';
  const lit = ON[ch] ?? '';
  for (const seg of ORDER) {
    const i = document.createElement('i');
    i.className = `led-seg seg-${seg}${lit.includes(seg) ? ' on' : ''}`;
    wrap.appendChild(i);
  }
  return wrap;
}

function pair(tagClass) {
  const wrap = document.createElement('span');
  wrap.className = tagClass;
  wrap.appendChild(document.createElement('i'));
  wrap.appendChild(document.createElement('i'));
  return wrap;
}

function buildColon(blink) {
  const wrap = pair(blink ? 'led-colon blink' : 'led-colon');
  return wrap;
}

function buildDot() {
  const wrap = document.createElement('span');
  wrap.className = 'led-dot';
  wrap.appendChild(document.createElement('i'));
  return wrap;
}

export class Led {
  constructor({ className = '', label = '' } = {}) {
    this.el = document.createElement('span');
    this.el.className = `led ${className}`.trim();
    if (label) { this.el.setAttribute('role', 'img'); this.el.setAttribute('aria-label', label); }
    this._key = null;
  }
  setText(str, { colonBlink = false } = {}) {
    if (str === this._key) return;
    this._key = str;
    this.el.textContent = '';
    for (const ch of str) {
      if (ch === ':') this.el.appendChild(buildColon(colonBlink));
      else if (ch === '.') this.el.appendChild(buildDot());
      else this.el.appendChild(buildDigit(ch));
    }
  }
}
