// 赛后数据卡：canvas 直绘，所见即所存（1080×1440，适合发班群）。
import { GameStore } from '../store.js';
import { api } from '../api.js';
import { h } from '../ui.js';

const W = 1080, H = 1440, M = 72;

const BG = '#0B0F1A';    // 底色
const CARD = '#151D33';  // 卡片底
const TRACK = '#1E2740'; // 对比条底槽
const LINE = '#26314E';  // 分隔线
const TXT = '#F3F6FC';   // 主文字
const DIM = '#C9D3E8';   // 次级数字
const SUB = '#8B96AB';   // 标签
const GOLD = '#F5B942';  // 得分王

const F = (size, weight = 600) => `${weight} ${size}px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`;
const FM = (size, weight = 800) => `${weight} ${size}px ui-monospace, "SF Mono", Consolas, monospace`;

function rr(ctx, x, y, w, h2, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h2, r); }

function fillRR(ctx, x, y, w, h2, r, fill) {
  rr(ctx, x, y, w, h2, r); ctx.fillStyle = fill; ctx.fill();
}

// 在圆角卡片顶部压一道队色（裁剪保证不溢出圆角）
function topStripe(ctx, x, y, w, h2, r, color) {
  ctx.save();
  rr(ctx, x, y, w, h2, r); ctx.clip();
  ctx.fillStyle = color; ctx.fillRect(x, y, w, 8);
  ctx.restore();
}

// 竖直居中于 [y, y+h] 的文本基线
const midBase = (y, h, size) => y + (h + size * 0.72) / 2;

// 超宽截断，防止长队名撑破面板
function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

// 队色当底色时，按 WCAG 相对亮度挑暗字或白字，避免深色队色配暗字糊掉
function inkOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.45 ? '#0B0F1A' : '#FFFFFF';
}

function drawCard(canvas, state, meta) {
  const ctx = canvas.getContext('2d');
  const s = state;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  const [A, B] = s.teams;
  const win = s.winner;
  const finished = s.status === 'finished';
  const tie = finished && win == null;
  const diff = Math.abs(A.score - B.score);

  // ---------- 顶部双色带：主队左、客队右 ----------
  ctx.fillStyle = A.color; ctx.fillRect(0, 0, W / 2, 10);
  ctx.fillStyle = B.color; ctx.fillRect(W / 2, 0, W / 2, 10);

  // ---------- 标题行 ----------
  ctx.font = F(32); ctx.fillStyle = SUB;
  ctx.textAlign = 'left'; ctx.fillText('校园班赛 · 数据卡', M, 112);
  ctx.textAlign = 'right'; ctx.fillText(meta.dateLabel, W - M, 112);
  ctx.textAlign = 'left';

  // ---------- 比分区：两块队伍面板 ----------
  const pY = 168, pH = 336, gap = 24;
  const pW = (W - M * 2 - gap) / 2;
  for (let ti = 0; ti < 2; ti += 1) {
    const t = s.teams[ti];
    const x = M + ti * (pW + gap);
    const cx = x + pW / 2;
    fillRR(ctx, x, pY, pW, pH, 26, CARD);
    topStripe(ctx, x, pY, pW, pH, 26, t.color);

    ctx.textAlign = 'center';
    ctx.font = F(40, 700); ctx.fillStyle = TXT;
    ctx.fillText(fit(ctx, t.name, pW - 56), cx, pY + 84);

    ctx.font = FM(128); ctx.fillStyle = t.color;
    ctx.fillText(String(t.score), cx, pY + 226);

    // 状态 pill：胜 / 落后 N 分 / 平局 / 进行中
    const isWin = finished && win === ti;
    const py = pY + 262, ph = 48;
    let label = null, bg = null, fg = SUB, stroke = LINE;
    if (!finished) label = '进行中';
    else if (tie) { label = '平局'; bg = GOLD; fg = '#0B0F1A'; stroke = null; }
    else if (isWin) { label = '获胜'; bg = t.color; fg = inkOn(t.color); stroke = null; }
    else if (diff > 0) label = `落后 ${diff} 分`;
    if (label) {
      ctx.font = F(28, 700);
      const pw = ctx.measureText(label).width + 56;
      rr(ctx, cx - pw / 2, py, pw, ph, ph / 2);
      if (bg) { ctx.fillStyle = bg; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
      ctx.fillStyle = fg;
      ctx.fillText(label, cx, midBase(py, ph, 28));
    }
  }

  // ---------- 每节得分 ----------
  const cols = A.periodScores.length;
  const tY = 584, tH = 214;
  ctx.textAlign = 'left';
  ctx.font = F(30); ctx.fillStyle = SUB;
  ctx.fillText('每节得分', M, 560);
  fillRR(ctx, M, tY, W - M * 2, tH, 22, CARD);

  const nameX = 96, nameW = 190;
  const dataL = 300, dataR = 984;
  const colW = (dataR - dataL) / (cols + 1);
  const headY = 640, sepY = 664, rowY = [712, 772];

  ctx.font = F(26); ctx.fillStyle = SUB;
  for (let i = 0; i < cols; i += 1) {
    ctx.textAlign = 'center';
    ctx.fillText(`Q${i + 1}`, dataL + (i + 0.5) * colW, headY);
  }
  ctx.fillStyle = DIM;
  ctx.fillText('合计', dataL + (cols + 0.5) * colW, headY);

  ctx.strokeStyle = LINE; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(nameX, sepY); ctx.lineTo(dataR, sepY); ctx.stroke();

  for (let ti = 0; ti < 2; ti += 1) {
    const t = s.teams[ti];
    const y = rowY[ti];
    // 队色方块 + 队名
    fillRR(ctx, nameX, y - 13, 14, 14, 4, t.color);
    ctx.textAlign = 'left';
    ctx.font = F(30, 700); ctx.fillStyle = TXT;
    ctx.fillText(fit(ctx, t.name, nameW), nameX + 26, y);
    // 每节分数
    ctx.font = FM(32);
    for (let i = 0; i < cols; i += 1) {
      ctx.textAlign = 'center';
      ctx.fillStyle = DIM;
      ctx.fillText(String(t.periodScores[i] ?? 0), dataL + (i + 0.5) * colW, y);
    }
    // 合计
    ctx.fillStyle = TXT;
    ctx.fillText(String(t.score), dataL + (cols + 0.5) * colW, y);
  }

  // ---------- 数据对比（双向条） ----------
  const hasPlayers = !!(s.config.trackPlayers && s.players.length
    && [...s.players].sort((x, y) => y.points - x.points)[0]?.points > 0);
  const rowH = hasPlayers ? 72 : 96;
  ctx.textAlign = 'left';
  ctx.font = F(30); ctx.fillStyle = SUB;
  ctx.fillText('数据对比', M, 854);

  // fouls 每节清零，赛后卡用全场累计；老对局没有该字段时退回本节数
  const rows = [
    ['三分命中', A.stats.pts3, B.stats.pts3],
    ['两分命中', A.stats.pts2, B.stats.pts2],
    ['罚球命中', A.stats.pts1, B.stats.pts1],
    ['犯规', A.foulsTotal ?? A.fouls, B.foulsTotal ?? B.fouls],
  ];
  const barCx = W / 2, barHalf = 140, barH = 14;
  rows.forEach(([label, a, b], i) => {
    const y = 884 + i * rowH;
    ctx.textAlign = 'center';
    ctx.font = F(26); ctx.fillStyle = SUB;
    ctx.fillText(label, barCx, y + 24);

    ctx.font = FM(44);
    ctx.textAlign = 'right'; ctx.fillStyle = A.color;
    ctx.fillText(String(a), barCx - 180, y + 68);
    ctx.textAlign = 'left'; ctx.fillStyle = B.color;
    ctx.fillText(String(b), barCx + 180, y + 68);

    const max = Math.max(a, b);
    if (max > 0) {
      const by = y + 50;
      fillRR(ctx, barCx - barHalf, by, barHalf * 2, barH, barH / 2, TRACK);
      const wa = (a / max) * barHalf, wb = (b / max) * barHalf;
      if (wa > 0) { rr(ctx, barCx - wa, by, wa, barH, barH / 2); ctx.fillStyle = A.color; ctx.fill(); }
      if (wb > 0) { rr(ctx, barCx, by, wb, barH, barH / 2); ctx.fillStyle = B.color; ctx.fill(); }
    }
  });

  // ---------- 得分榜 ----------
  if (hasPlayers) {
    const top3 = [...s.players].sort((x, y) => y.points - x.points).slice(0, 3);
    const kY = 1200, kH = 140;
    fillRR(ctx, M, kY, W - M * 2, kH, 22, CARD);
    ctx.save();
    rr(ctx, M, kY, W - M * 2, kH, 22); ctx.clip();
    ctx.fillStyle = GOLD; ctx.fillRect(M, kY, 8, kH);
    ctx.restore();

    const base = [kY + 50, kY + 92, kY + 132];
    top3.forEach((p, i) => {
      const y = base[i];
      const first = i === 0;
      ctx.textAlign = 'left';
      ctx.font = F(26, 700); ctx.fillStyle = first ? GOLD : SUB;
      ctx.fillText(String(i + 1), 112, y);
      ctx.font = F(first ? 32 : 28, first ? 700 : 600);
      ctx.fillStyle = first ? GOLD : TXT;
      ctx.fillText(fit(ctx, p.name, 300), 152, y);
      ctx.font = FM(first ? 38 : 32);
      ctx.fillStyle = first ? GOLD : DIM;
      ctx.textAlign = 'right';
      ctx.fillText(`${p.points} 分`, 984, y);
    });
  }

  // ---------- 页脚 ----------
  ctx.textAlign = 'center';
  ctx.font = F(26); ctx.fillStyle = SUB;
  ctx.fillText(`房间码 ${meta.code} · 篮球计分板`, W / 2, H - 56);
}

export default {
  title: '篮球计分板 · 数据卡',
  mount(root, [rawCode]) {
    const code = rawCode.toUpperCase();
    const store = new GameStore(code);
    const canvas = h('canvas', { class: 'card-canvas', width: W, height: H, 'aria-label': '比赛数据卡' });
    const body = h('div');
    const fileName = (s) => `数据卡-${s.teams[0].name}vs${s.teams[1].name}.png`;

    // iOS Safari 至今不认 <a download>（WebKit bug 167341 仍是 OPEN），
    // 在 iPhone 上点「保存图片」只会打开一张图、要长按才能存，体验是断的。
    // 那边必须走 navigator.share({ files })，系统分享面板里的「存储图像」直接进相册。
    // 而 WebKit 的 share() 要求同步发生在用户手势里——UserGesture 不会传进 toBlob 回调，
    // 所以 File 必须提前备好，点击时才能同步 share。
    let shareFile = null;
    let shareSig = '';
    const sigOf = (s) => [
      s.status, s.finishedAt || '',
      s.teams[0].name, s.teams[1].name, s.teams[0].score, s.teams[1].score,
      s.teams[0].foulsTotal ?? s.teams[0].fouls, s.teams[1].foulsTotal ?? s.teams[1].fouls,
      s.players.map((p) => p.points).join(','),
    ].join('|');
    const canShareFiles = (f) => {
      try { return !!(navigator.canShare && navigator.share && navigator.canShare({ files: [f] })); }
      catch { return false; }
    };
    // 画完就顺手编码一份备用；状态变了才重编，别每次轮询都压一张 150KB 的 PNG
    const prepShare = (s) => {
      const sig = sigOf(s);
      if (sig === shareSig) return;
      shareSig = sig;
      shareFile = null;
      canvas.toBlob((blob) => {
        if (!blob) return;
        try {
          shareFile = new File([blob], fileName(s), { type: 'image/png' });
        } catch { shareFile = null; } // 老浏览器没有 File 构造器，退回 <a download>
      }, 'image/png');
    };

    // 按钮先禁用：画布没画出来之前点保存，存出去的是一张空白图
    // （线上实测过：状态未回来时 toBlob 立刻执行，文件名还会变成 undefinedvsundefined）
    const saveBtn = h('button', {
      class: 'primary big', type: 'button', disabled: true,
      onclick: (e) => {
        const s = store.state;
        if (!s) return;
        // 1) iPhone / Android：系统分享面板，「存储图像」进相册
        if (shareFile && canShareFiles(shareFile)) {
          navigator.share({
            files: [shareFile],
            title: '赛后数据卡',
            text: `${s.teams[0].name} ${s.teams[0].score} : ${s.teams[1].score} ${s.teams[1].name}`,
          }).catch(() => { /* 用户取消分享，不算错误 */ });
          return;
        }
        // 2) 桌面：<a download> 直接落盘
        const done = (blob) => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = fileName(s);
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        };
        if (shareFile) { done(shareFile); return; } // 已备好的 File 本身就是 Blob
        canvas.toBlob((blob) => {
          if (!blob) { e.target.textContent = '保存失败，请截图保存'; return; }
          done(blob);
        }, 'image/png');
      },
    }, '保存图片');
    const copyBtn = h('button', {
      class: 'ghost big', type: 'button', disabled: true,
      onclick: async (e) => {
        try { await navigator.clipboard.writeText(location.href); e.target.textContent = '已复制 ✓'; }
        catch { e.target.textContent = '复制失败'; }
      },
    }, '复制链接');

    // ---------- 操作记录：赛后吵架时的核对面板 ----------
    // 数据来自 /api/game?action=log（公开读，和比分同级）：
    // 每一次落地都记了谁（凭证指纹）/何时/什么动作/比分从多少变成多少。
    // 只在新版本到达时拉一次，不跟着 3 秒轮询反复请求。
    const logBox = h('div', { class: 'card-log', hidden: true });
    let logVersion = -1;
    const logLabel = (entry) => {
      let a = {};
      try { a = JSON.parse(entry.action); } catch { /* 老记录按原样展示 */ }
      const s = store.state;
      const tn = (i) => s?.teams?.[i]?.name || (i === 0 ? '主队' : '客队');
      switch (a.type) {
        case 'score': return `${tn(a.team)} +${a.points}${a.playerId ? `（${a.playerId}）` : ''}`;
        case 'foul': return `${tn(a.team)} 犯规 +1`;
        case 'timeout': return `${tn(a.team)} 暂停`;
        case 'possession': return `球权 → ${tn(a.team)}`;
        case 'clock_start': return '开始计时';
        case 'clock_stop': return '停表';
        case 'shot_reset': return '24 秒归满';
        case 'clock_zero': return '时钟归零上报';
        case 'period_next': return '下一节';
        case 'finish': return '结束比赛';
        case 'reset': return '重开一场';
        case 'undo': return '撤销';
        default: return a.type || '未知动作';
      }
    };
    const paintLog = (entries) => {
      if (!entries.length) { logBox.hidden = true; return; }
      logBox.hidden = false;
      logBox.replaceChildren(
        h('h3', { class: 'card-log-title' }, '操作记录 · 可核对'),
        ...entries.slice(0, 12).map((e) => h('p', { class: 'card-log-item' },
          h('span', { class: 'log-time' }, new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false })),
          h('span', { class: 'log-act' }, logLabel(e)),
          h('span', { class: 'log-score' }, `${e.before_score} → ${e.after_score}`),
          h('span', { class: 'log-actor' }, e.actor))),
        // 注意：这里不能写 `cond && h(...)`——false 会被 replaceChildren 当成文本节点渲染出「false」
        // （实测在截图里看到过）。超长提示要么整块给，要么不给。
        ...(entries.length > 12
          ? [h('p', { class: 'muted small' }, `……还有 ${entries.length - 12} 条，完整记录以服务端为准`)]
          : []));
    };
    const loadLog = async () => {
      try { paintLog((await api(`/api/game?action=log&code=${encodeURIComponent(code)}`)).entries || []); }
      catch { logBox.hidden = true; } // 读不到审计不影响数据卡本身
    };
    const panel = h('div', { class: 'card-wrap' }, canvas, h('div', { class: 'btn-row' }, saveBtn, copyBtn), logBox);

    root.append(
      h('header', { class: 'brand' }, h('a', { href: `/room/${code}`, 'data-link': true, class: 'back' }, '← 房间'), h('h1', null, '赛后数据卡')),
      body);

    let ready = false;
    const render = () => {
      if (store.fatal) {
        body.replaceChildren(h('section', { class: 'panel center' },
          h('p', { class: 'big-err' }, store.fatal.message),
          h('a', { href: '/', 'data-link': true, class: 'primary big' }, '返回首页')));
        return;
      }
      const s = store.state;
      if (!s) {
        body.replaceChildren(h('section', { class: 'panel center' }, h('p', { class: 'muted' }, '加载中…')));
        return;
      }
      if (!ready) {
        ready = true;
        body.replaceChildren(panel);
        saveBtn.disabled = false;
        copyBtn.disabled = false;
      }
      drawCard(canvas, s, {
        code,
        dateLabel: new Date(s.finishedAt || s.startedAt || Date.now()).toLocaleDateString('zh-CN'),
      });
      prepShare(s);
      if (s.version !== logVersion) { logVersion = s.version; loadLog(); }
    };
    const un = store.subscribe(render);
    store.start(3000);
    render();
    return { cleanup() { store.stop(); un(); } };
  },
};
