// 首页：新建比赛 / 加入房间。打开即是工具，无营销页。
import { api } from '../api.js';
import { navigate } from '../router.js';
import { h, COLORS, colorPicker } from '../ui.js';

const CODE_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;

export default {
  title: '篮球计分板 · 新建比赛',
  mount(root) {
    const team = (name, color) => ({ name, color });
    const A = team('', COLORS[1]);
    const B = team('', COLORS[0]);
    const players = { 0: [], 1: [] };
    let busy = false;

    const nameA = h('input', { class: 'inp', placeholder: '如：计算机1班', maxlength: 16, 'aria-label': '主队名' });
    const nameB = h('input', { class: 'inp', placeholder: '如：软件工程2班', maxlength: 16, 'aria-label': '客队名' });
    const periods = h('select', { class: 'inp', 'aria-label': '节数' },
      h('option', { value: '2' }, '2 节'), h('option', { value: '4', selected: true }, '4 节'));
    const minutes = h('select', { class: 'inp', 'aria-label': '每节时长' },
      ...[5, 10, 12, 15].map((m) => h('option', { value: String(m), selected: m === 10 }, `${m} 分钟`)));
    const foulLimit = h('input', { class: 'inp num', type: 'number', min: 1, max: 10, value: 5, 'aria-label': '单节犯规上限' });
    const timeouts = h('input', { class: 'inp num', type: 'number', min: 0, max: 10, value: 3, 'aria-label': '每队暂停次数' });
    const shotClock = h('input', { type: 'checkbox' });
    const trackPlayers = h('input', { type: 'checkbox' });
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });

    const swatchA = h('div');
    const swatchB = h('div');
    const renderSwatches = () => {
      swatchA.replaceChildren(colorPicker(A.color, (c) => { A.color = c; renderSwatches(); }));
      swatchB.replaceChildren(colorPicker(B.color, (c) => { B.color = c; renderSwatches(); }));
    };
    renderSwatches();

    const playerList = (t) => {
      const box = h('div', { class: 'plist' });
      const redraw = () => {
        box.replaceChildren(...players[t].map((p, i) => h('div', { class: 'prow' },
          h('input', {
            class: 'inp', value: p.name, placeholder: `球员 ${i + 1}`, maxlength: 8,
            'aria-label': `第${i + 1}名球员`,
            oninput: (e) => { players[t][i].name = e.target.value; },
          }),
          h('button', {
            type: 'button', class: 'icon-btn', 'aria-label': '移除该球员',
            onclick: () => { players[t].splice(i, 1); redraw(); },
          }, '×'),
        )));
      };
      box.dataset.team = String(t);
      redraw();
      return {
        el: h('div', { class: 'pcolumn' },
          h('h4', null, t === 0 ? '主队球员' : '客队球员'),
          box,
          h('button', {
            type: 'button', class: 'ghost', disabled: players[t].length >= 15,
            onclick: () => { if (players[t].length < 15) { players[t].push({ name: '' }); redraw(); } },
          }, '+ 添加球员')),
        syncDisabled: () => {},
      };
    };
    const plA = playerList(0);
    const plB = playerList(1);
    const playerSection = h('div', { class: 'players', hidden: true }, plA.el, plB.el);

    const submit = h('button', { class: 'primary big', type: 'button' }, '创建比赛 →');
    const onCreate = async () => {
      if (busy) return;
      err.hidden = true;
      A.name = nameA.value.trim();
      B.name = nameB.value.trim();
      if (!A.name || !B.name) return showErr('请填写两队队名');
      if (A.name === B.name) return showErr('两队队名不能相同');
      const list = trackPlayers.checked
        ? [0, 1].flatMap((t) => players[t].map((p) => ({ team: t, name: p.name.trim() })).filter((p) => p.name))
        : [];
      busy = true;
      submit.disabled = true;
      submit.textContent = '创建中…';
      try {
        const res = await api('/functions/v1/app?action=create', {
          method: 'POST',
          body: {
            teams: [{ name: A.name, color: A.color }, { name: B.name, color: B.color }],
            config: {
              periods: Number(periods.value),
              periodMinutes: Number(minutes.value),
              foulLimit: Number(foulLimit.value),
              timeouts: Number(timeouts.value),
              shotClock: shotClock.checked,
              trackPlayers: trackPlayers.checked,
            },
            players: list,
          },
        });
        navigate(`/room/${res.code}`);
      } catch (e) {
        showErr(e.message);
        busy = false;
        submit.disabled = false;
        submit.textContent = '创建比赛 →';
      }
    };
    const showErr = (msg) => { err.textContent = msg; err.hidden = false; };
    submit.addEventListener('click', onCreate);

    const joinInput = h('input', {
      class: 'inp code-input', maxlength: 4, placeholder: '4K7P', autocapitalize: 'characters',
      autocomplete: 'off', spellcheck: false, 'aria-label': '房间码',
      oninput: (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^2-9A-HJ-NP-Z]/g, '').slice(0, 4); },
      onkeydown: (e) => { if (e.key === 'Enter') onJoin(); },
    });
    const onJoin = () => {
      const code = joinInput.value.trim();
      if (!CODE_RE.test(code)) { joinErr.textContent = '房间码是 4 位字母数字（不含 0、O、1、I）'; joinErr.hidden = false; return; }
      navigate(`/room/${code}`);
    };
    const joinErr = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const joinBtn = h('button', { class: 'ghost big', type: 'button', onclick: onJoin }, '进入房间');

    root.append(
      h('header', { class: 'brand' },
        h('span', { class: 'brand-led' }, '🏀'),
        h('h1', null, '篮球计分板'),
        h('span', { class: 'tag' }, '校园班赛专用')),
      h('main', { class: 'home' },
        h('section', { class: 'panel' },
          h('h2', null, '新建比赛'),
          h('div', { class: 'team-grid' },
            h('div', { class: 'team-card' }, nameA, swatchA),
            h('div', { class: 'vs' }, 'VS'),
            h('div', { class: 'team-card' }, nameB, swatchB)),
          h('div', { class: 'rules-grid' },
            field('赛制', h('div', { class: 'row' }, periods, minutes)),
            field('单节犯规上限', foulLimit),
            field('每队暂停', timeouts)),
          h('label', { class: 'check' }, shotClock, '开启 24 秒进攻时限'),
          h('label', { class: 'check' }, trackPlayers, '记录球员得分（赛后数据卡出得分王）'),
          playerSection,
          submit,
          err),
        h('section', { class: 'panel join' },
          h('h2', null, '加入比赛'),
          h('p', { class: 'muted' }, '输入 4 位房间码，或直接扫码/用另一台设备打开链接'),
          joinInput, joinBtn, joinErr)),
    );

    trackPlayers.addEventListener('change', () => {
      playerSection.hidden = !trackPlayers.checked;
    });

    return { cleanup() {} };
  },
};

function field(label, control) {
  return h('label', { class: 'field' }, h('span', null, label), control);
}
