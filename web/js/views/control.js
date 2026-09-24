// 控制端：记分员的手机遥控器。大按钮、单手拇指区、断网排队、WakeLock。
import { GameStore } from '../store.js';
import { formatClock } from '../clock.js';
import { Led } from '../led.js';
import { sounds, primeAudio } from '../audio.js';
import { navigate } from '../router.js';
import { h } from '../ui.js';

export default {
  title: '篮球计分板 · 控制端',
  mount(root, [rawCode]) {
    const code = rawCode.toUpperCase();
    const store = new GameStore(code);
    const sel = { 0: null, 1: null };
    let undoLock = false;
    let zeroHandled = false;
    let lastFinished = null;
    let wakeLock = null;

    const statusDot = h('span', { class: 'dot' });
    const statusText = h('span', { class: 'status-text' }, '连接中…');
    const undoBtn = h('button', { class: 'ghost small', type: 'button', disabled: true }, '↩ 撤销');
    const periodTag = h('span', { class: 'period-tag' }, 'Q1');
    const clockLed = new Led({ className: 'led-clock', label: '比赛时钟' });
    const shotLed = new Led({ className: 'led-shot', label: '进攻时限' });
    const possArrow = h('span', { class: 'poss' });
    const startBtn = h('button', { class: 'primary clock-btn', type: 'button' }, '▶ 开始');
    const clockArea = h('div', { class: 'clock-strip' },
      h('div', { class: 'clock-line' }, periodTag, clockLed.el, shotLed.el, possArrow),
      startBtn);
    const teamsBox = h('div', { class: 'ctrl-teams' });
    const footer = h('div', { class: 'ctrl-foot' });
    const toast = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite', hidden: true });

    root.append(
      h('header', { class: 'ctrl-head' },
        h('div', { class: 'head-line' },
          h('a', { href: `/room/${code}`, 'data-link': true, class: 'back' }, code),
          h('div', { class: 'conn' }, statusDot, statusText),
          undoBtn),
        clockArea, teamsBox, footer, toast));

    let built = null; // 已构建的球队面板引用
    const buildTeams = (s) => {
      const panels = s.teams.map((t, ti) => {
        const scoreLed = new Led({ className: 'led-score', label: `${t.name}得分` });
        scoreLed.setText(String(t.score));
        const chips = h('div', { class: 'chips', hidden: !s.config.trackPlayers });
        const foulCount = h('span', { class: 'mini' }, '犯规 0');
        const toCount = h('span', { class: 'mini' }, `暂停 ${t.timeoutsLeft}`);
        const scoreBtns = [1, 2, 3].map((p) => h('button', {
          class: 'btn-score', type: 'button', 'aria-label': `${t.name} 加${p}分`,
          onclick: () => score(ti, p),
        }, `+${p}`));
        const panel = h('section', { class: 'team-panel', style: `--tc:${t.color}` },
          h('div', { class: 'tp-head' },
            h('h3', null, t.name),
            scoreLed.el),
          chips,
          h('div', { class: 'score-btns' }, ...scoreBtns),
          h('div', { class: 'tp-foot' },
            foulCount,
            toCount,
            h('button', { class: 'ghost small', type: 'button', onclick: () => send({ type: 'foul', team: ti }) }, '犯规+1'),
            h('button', { class: 'ghost small', type: 'button', onclick: () => send({ type: 'timeout', team: ti }) }, '暂停')));
        return { panel, scoreLed, chips, foulCount, toCount, scoreBtns, team: t };
      });
      teamsBox.replaceChildren(...panels.map((p) => p.panel));
      built = { panels, sig: sigOf(s) };
      renderChips(0, s); renderChips(1, s); paintChips(s);
    };

    const sigOf = (s) => `${s.teams[0].name}|${s.teams[1].name}|${s.config.trackPlayers}|${s.players.length}`;

    // Chip 只在名单变化时重建，平时就地改文本/选中态——避免每秒重建节点打断点击
    const renderChips = (ti, s) => {
      if (!s.config.trackPlayers) return;
      const box = built.panels[ti].chips;
      const list = s.players.filter((p) => p.team === ti);
      const key = list.map((p) => p.name).join('|');
      if (box.dataset.key !== key) {
        box.dataset.key = key;
        box.replaceChildren(...list.map((p) => {
          const el = h('button', {
            type: 'button', class: 'chip', 'aria-pressed': 'false',
            onclick: () => { sel[ti] = sel[ti] === p.name ? null : p.name; paintChips(store.state); },
          });
          el.dataset.name = p.name;
          return el;
        }));
      }
    };

    const paintChips = (s) => {
      if (!s || !s.config.trackPlayers || !built) return;
      for (const ti of [0, 1]) {
        for (const el of built.panels[ti].chips.children) {
          const p = s.players.find((x) => x.team === ti && x.name === el.dataset.name);
          if (!p) continue;
          el.textContent = `${p.name} ${p.points}`;
          const on = sel[ti] === p.name;
          el.classList.toggle('sel', on);
          el.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
      }
    };

    const score = (ti, points) => send({ type: 'score', team: ti, points, playerId: sel[ti] || undefined });

    async function send(action) {
      primeAudio();
      const res = await store.apply(action);
      if (res.ok) { navigator.vibrate?.(15); sounds.score(); }
      else if (res.error) showToast(res.error.message);
      else if (res.conflict) showToast(res.error.message);
    }

    undoBtn.addEventListener('click', async () => {
      if (undoLock) return;
      undoLock = true;
      undoBtn.disabled = true;
      const res = await store.apply({ type: 'undo' });
      if (res.error) showToast(res.error.message);
      setTimeout(() => { undoLock = false; }, 1000);
    });

    startBtn.addEventListener('click', () => {
      const d = store.clock();
      primeAudio();
      if (!d) return;
      if (d.mode !== 'game') { showToast('倒计时结束后才能开始比赛计时'); return; }
      send({ type: d.running ? 'clock_stop' : 'clock_start' });
    });

    let toastTimer = null;
    function showToast(msg) {
      toast.textContent = msg;
      toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
    }

    // ---- 状态渲染 ----
    const onState = () => {
      if (store.fatal) {
        root.replaceChildren(h('section', { class: 'panel center' },
          h('p', { class: 'big-err' }, store.fatal.message),
          h('a', { href: '/', 'data-link': true, class: 'primary big' }, '回首页')));
        return;
      }
      const s = store.state;
      if (!s) return;
      if (!built || sigOf(s) !== built.sig) buildTeams(s);
      const d = store.clock();
      const finished = store.status === 'finished';
      for (let ti = 0; ti < 2; ti += 1) {
        const t = s.teams[ti];
        built.panels[ti].scoreLed.setText(String(t.score));
        built.panels[ti].foulCount.textContent = `犯规 ${t.fouls}/${s.config.foulLimit}`;
        built.panels[ti].toCount.textContent = `暂停 ${t.timeoutsLeft}`;
        built.panels[ti].scoreBtns.forEach((b) => { b.disabled = finished; });
      }
      renderChips(0, s); renderChips(1, s); paintChips(s);
      periodTag.textContent = finished ? '已结束' : d.mode === 'timeout' ? '暂停' : d.mode === 'break' ? '节间' : `Q${d.period}`;
      startBtn.textContent = d.running ? '⏸ 暂停计时' : '▶ 开始';
      startBtn.disabled = finished;
      possArrow.textContent = s.possession === 0 ? `◀ ${s.teams[0].name}` : `${s.teams[1].name} ▶`;
      shotLed.el.hidden = !s.config.shotClock;
      undoBtn.disabled = undoLock || !s.undo;

      if (finished !== lastFinished) {
        lastFinished = finished;
        footer.replaceChildren(
          finished
            ? h('div', { class: 'btn-row' },
              h('button', { class: 'primary big', type: 'button', onclick: () => navigate(`/room/${code}/card`) }, '查看数据卡'),
              h('button', { class: 'ghost big', type: 'button', onclick: async () => {
                if (!confirm('重开一场比赛？当前比分将清空并回到设置状态。')) return;
                await send({ type: 'reset' });
              } }, '重开一场'))
            : h('div', { class: 'btn-row' },
              h('button', { class: 'ghost', type: 'button', onclick: () => send({ type: 'period_next' }) }, '下一节 ▶'),
              h('button', { class: 'danger', type: 'button', onclick: async () => {
                if (!confirm('确认结束比赛？结束后比分锁定，数据卡自动生成。')) return;
                await send({ type: 'finish' });
              } }, '🏁 结束比赛')));
      }
      paintClock();
    };

    function paintClock() {
      const s = store.state;
      if (!s) return;
      const d = store.clock();
      const tenths = d.mode === 'game' && d.remainingMs < 60000;
      clockLed.setText(formatClock(d.remainingMs, tenths), { colonBlink: d.running });
      const sh = store.shot();
      if (sh) shotLed.setText(String(Math.ceil(sh.remainingMs / 1000)).padStart(2, '0'));
      if (d.zero && !zeroHandled) {
        zeroHandled = true;
        sounds.buzzer();
        navigator.vibrate?.([80, 60, 80]);
        store.apply({ type: 'clock_zero' });
      }
      if (!d.zero) zeroHandled = false;
      // 连接状态
      const queued = store.queue.length;
      statusDot.className = `dot ${store.fatal ? 'off' : store.stale() ? 'weak' : queued ? 'queue' : 'on'}`;
      statusText.textContent = store.stale() ? '信号弱' : queued ? `${queued} 个待发送` : '在线';
    }

    const un = store.subscribe(onState);
    store.start(1000);
    const tick = setInterval(paintClock, 100);

    // ---- WakeLock：比赛期间防锁屏 ----
    async function keepAwake() {
      try {
        wakeLock?.release?.().catch(() => {});
        wakeLock = await navigator.wakeLock?.request('screen');
      } catch { /* 不支持则放弃 */ }
    }
    const onVisible = () => { if (!document.hidden) { keepAwake(); } };
    document.addEventListener('visibilitychange', onVisible);
    keepAwake();

    // ---- 键盘快捷键（笔记本当控制端） ----
    const onKey = (e) => {
      if (e.target.matches('input,textarea,select')) return;
      const s = store.state;
      if (!s || store.status === 'finished') return;
      const map = { a: [0, 1], s: [0, 2], d: [0, 3], j: [1, 1], k: [1, 2], l: [1, 3] };
      const hit = map[e.key.toLowerCase()];
      if (hit) { e.preventDefault(); score(hit[0], hit[1]); return; }
      if (e.key === ' ') { e.preventDefault(); startBtn.click(); return; }
      if (e.key.toLowerCase() === 'z') { e.preventDefault(); undoBtn.click(); }
    };
    window.addEventListener('keydown', onKey);

    return {
      cleanup() {
        store.stop();
        un();
        clearInterval(tick);
        clearTimeout(toastTimer);
        window.removeEventListener('keydown', onKey);
        document.removeEventListener('visibilitychange', onVisible);
        wakeLock?.release?.().catch(() => {});
      },
    };
  },
};
