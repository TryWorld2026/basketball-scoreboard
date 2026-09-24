// 赛后数据卡：canvas 直绘，所见即所存（1080×1440，适合发班群）。
import { GameStore } from '../store.js';
import { h } from '../ui.js';

const W = 1080, H = 1440;

function roundRect(ctx, x, y, w, h2, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h2, r);
}

function drawCard(canvas, state, meta) {
  const ctx = canvas.getContext('2d');
  const s = state;
  // canvas 状态跨次绘制残留，每次从确定状态开始
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#0A0E1A';
  ctx.fillRect(0, 0, W, H);

  // 顶部队色光带
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, s.teams[0].color);
  g.addColorStop(0.5, '#141B2E');
  g.addColorStop(1, s.teams[1].color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, 14);

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#8B96AB';
  ctx.font = '600 34px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText('校园班赛 · 数据卡', 72, 110);
  ctx.textAlign = 'right';
  ctx.fillText(meta.dateLabel, W - 72, 110);
  ctx.textAlign = 'left';

  // 比分区
  const win = s.winner;
  const rowY = 250;
  ctx.textAlign = 'left';
  ctx.fillStyle = s.teams[0].color;
  ctx.font = '700 52px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(s.teams[0].name, 72, rowY);
  ctx.textAlign = 'right';
  ctx.fillStyle = s.teams[1].color;
  ctx.fillText(s.teams[1].name, W - 72, rowY);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#F3F6FC';
  ctx.font = '800 150px ui-monospace, "SF Mono", Consolas, monospace';
  ctx.fillText(`${s.teams[0].score} : ${s.teams[1].score}`, W / 2, rowY + 160);
  if (win != null) {
    ctx.font = '600 34px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = s.teams[win].color;
    ctx.fillText(`${s.teams[win].name} 获胜`, W / 2, rowY + 220);
  } else if (s.status === 'finished') {
    ctx.font = '600 34px system-ui, "PingFang SC", sans-serif';
    ctx.fillStyle = '#F59E0B';
    ctx.fillText('平局', W / 2, rowY + 220);
  } else {
    ctx.font = '600 34px system-ui, "PingFang SC", sans-serif';
    ctx.fillStyle = '#F59E0B';
    ctx.fillText('比赛进行中', W / 2, rowY + 220);
  }

  // 每节流水表
  const cols = s.teams[0].periodScores.length;
  const tableY = 620;
  const colW = (W - 144 - 240) / (cols + 1);
  ctx.fillStyle = '#141B2E';
  roundRect(ctx, 72, tableY, W - 144, 190, 20);
  ctx.fill();
  ctx.font = '600 30px system-ui, "PingFang SC", sans-serif';
  ctx.fillStyle = '#8B96AB';
  ctx.fillText('每节得分', 96, tableY + 46);
  ctx.textAlign = 'left';
  for (let i = 0; i < cols; i += 1) {
    const x = 312 + (i + 0.5) * colW;
    ctx.fillStyle = '#8B96AB';
    ctx.fillText(`Q${i + 1}`, x, tableY + 46);
  }
  ctx.fillStyle = '#F3F6FC';
  ctx.fillText(`合计`, 312 + (cols + 0.5) * colW, tableY + 46);
  for (let ti = 0; ti < 2; ti += 1) {
    const y = tableY + 100 + ti * 56;
    ctx.textAlign = 'left';
    ctx.fillStyle = s.teams[ti].color;
    ctx.font = '700 32px system-ui, "PingFang SC", sans-serif';
    ctx.fillText(s.teams[ti].name.slice(0, 8), 96, y);
    ctx.font = '600 32px ui-monospace, Consolas, monospace';
    ctx.fillStyle = '#E8EDF7';
    for (let i = 0; i < cols; i += 1) {
      ctx.textAlign = 'center';
      ctx.fillText(String(s.teams[ti].periodScores[i] ?? 0), 312 + (i + 0.5) * colW, y);
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = '#F3F6FC';
    ctx.fillText(String(s.teams[ti].score), 312 + (cols + 0.5) * colW, y);
  }
  ctx.textAlign = 'left';

  // 对比统计
  const stats = [
    ['三分命中', s.teams[0].stats.pts3, s.teams[1].stats.pts3],
    ['两分命中', s.teams[0].stats.pts2, s.teams[1].stats.pts2],
    ['罚球命中', s.teams[0].stats.pts1, s.teams[1].stats.pts1],
    ['犯规', s.teams[0].fouls, s.teams[1].fouls],
  ];
  let sy = 880;
  for (const [label, a, b] of stats) {
    ctx.fillStyle = '#8B96AB';
    ctx.font = '600 30px system-ui, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, W / 2, sy);
    ctx.font = '800 40px ui-monospace, Consolas, monospace';
    ctx.fillStyle = a >= b ? s.teams[0].color : '#E8EDF7';
    ctx.textAlign = 'right';
    ctx.fillText(String(a), W / 2 - 120, sy);
    ctx.fillStyle = b >= a ? s.teams[1].color : '#E8EDF7';
    ctx.textAlign = 'left';
    ctx.fillText(String(b), W / 2 + 120, sy);
    sy += 62;
  }

  // 得分王
  if (s.config.trackPlayers && s.players.length) {
    const top = [...s.players].sort((x, y) => y.points - x.points)[0];
    if (top && top.points > 0) {
      ctx.fillStyle = '#141B2E';
      roundRect(ctx, 72, sy + 10, W - 144, 96, 20);
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.fillStyle = '#F59E0B';
      ctx.font = '700 40px system-ui, "PingFang SC", sans-serif';
      ctx.fillText(`★ 得分王  ${top.name}  ${top.points} 分`, W / 2, sy + 72);
    }
  }

  // 页脚
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8B96AB';
  ctx.font = '600 28px system-ui, "PingFang SC", sans-serif';
  ctx.fillText(`房间码 ${meta.code} · 篮球计分板`, W / 2, H - 64);
}

export default {
  title: '篮球计分板 · 数据卡',
  mount(root, [rawCode]) {
    const code = rawCode.toUpperCase();
    const store = new GameStore(code);
    const canvas = h('canvas', { class: 'card-canvas', width: W, height: H, 'aria-label': '比赛数据卡' });
    const wrap = h('div', { class: 'card-wrap' },
      h('header', { class: 'brand' }, h('a', { href: `/room/${code}`, 'data-link': true, class: 'back' }, '← 房间'), h('h1', null, '赛后数据卡')),
      canvas,
      h('div', { class: 'btn-row' },
        h('button', {
          class: 'primary big', type: 'button', onclick: (e) => {
            canvas.toBlob((blob) => {
              if (!blob) { e.target.textContent = '保存失败，请截图保存'; return; }
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              const s = store.state;
              a.download = `数据卡-${s?.teams[0].name}vs${s?.teams[1].name}.png`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(a.href), 4000);
            }, 'image/png');
          },
        }, '保存图片'),
        h('button', {
          class: 'ghost big', type: 'button',
          onclick: async (e) => {
            try { await navigator.clipboard.writeText(location.href); e.target.textContent = '已复制 ✓'; }
            catch { e.target.textContent = '复制失败'; }
          },
        }, '复制链接')));
    root.append(wrap);

    const render = () => {
      const s = store.state;
      if (!s) return;
      drawCard(canvas, s, {
        code,
        dateLabel: new Date(s.finishedAt || s.startedAt || Date.now()).toLocaleDateString('zh-CN'),
      });
    };
    const un = store.subscribe(render);
    store.start(3000);
    render();
    return { cleanup() { store.stop(); un(); } };
  },
};
