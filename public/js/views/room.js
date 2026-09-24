// 房间页：大号房间码 + 二维码 + 两端入口。
import { GameStore } from '../store.js';
import { navigate } from '../router.js';
import { h } from '../ui.js';

function qrSvg(text) {
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const doc = new DOMParser().parseFromString(qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true }), 'image/svg+xml');
  const svg = doc.documentElement;
  return svg.nodeName === 'svg' ? document.importNode(svg, true) : h('span', { class: 'muted' }, '二维码生成失败');
}

export default {
  title: '篮球计分板 · 房间',
  mount(root, [rawCode]) {
    const code = rawCode.toUpperCase();
    const store = new GameStore(code);
    const body = h('div', { class: 'room-body' });
    root.append(h('header', { class: 'brand' },
      h('a', { href: '/', 'data-link': true, class: 'back' }, '← 返回'),
      h('h1', null, '比赛房间')), body);

    const render = () => {
      if (store.fatal) {
        body.replaceChildren(h('section', { class: 'panel center' },
          h('p', { class: 'big-err' }, store.fatal.message),
          h('a', { href: '/', 'data-link': true, class: 'primary big' }, '新建一场比赛')));
        return;
      }
      if (!store.state) {
        body.replaceChildren(h('section', { class: 'panel center' }, h('p', { class: 'muted' }, '加载中…')));
        return;
      }
      const s = store.state;
      const url = `${location.origin}/room/${code}/display`;
      body.replaceChildren(
        h('section', { class: 'panel center' },
          h('p', { class: 'muted' }, '房间码'),
          h('p', { class: 'room-code' }, code),
          h('div', { class: 'qr' }, qrSvg(url)),
          h('p', { class: 'muted small' }, '大屏扫码，或把链接发到班级群'),
          h('div', { class: 'team-line' },
            h('span', { style: `--tc:${s.teams[0].color}` }, s.teams[0].name),
            h('span', { class: 'muted' }, ' vs '),
            h('span', { style: `--tc:${s.teams[1].color}` }, s.teams[1].name)),
          h('div', { class: 'btn-row' },
            h('button', { class: 'primary big', type: 'button', onclick: () => navigate(`/room/${code}/display`) }, '打开大屏'),
            h('button', { class: 'ghost big', type: 'button', onclick: () => navigate(`/room/${code}/control`) }, '打开遥控器')),
          h('button', {
            class: 'ghost', type: 'button',
            onclick: async (e) => {
              try { await navigator.clipboard.writeText(url); e.target.textContent = '已复制 ✓'; }
              catch { e.target.textContent = '复制失败，请长按地址栏复制'; }
            },
          }, '复制大屏链接'),
          store.status !== 'setup' && h('a', { class: 'status-link', href: `/room/${code}/control`, 'data-link': true },
            store.status === 'finished' ? '比赛已结束 → 查看数据卡' : '比赛进行中 → 回到控制端')));
    };

    const un = store.subscribe(render);
    store.start(2000);
    render();
    return { cleanup() { store.stop(); un(); } };
  },
};
