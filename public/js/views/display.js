// 大屏展示端：只读、零操作、三米外看清。
import { GameStore } from '../store.js';
import { formatClock } from '../clock.js';
import { Led } from '../led.js';
import { sounds, primeAudio } from '../audio.js';
import { navigate } from '../router.js';
import { h } from '../ui.js';

export default {
  title: '篮球计分板 · 大屏',
  mount(root, [rawCode]) {
    const code = rawCode.toUpperCase();
    const store = new GameStore(code);
    let zeroHandled = false;
    let finishedAt = null;

    const stage = h('div', { class: 'display' });
    root.append(stage);

    const scoreA = new Led({ className: 'led-big', label: '主队得分' });
    const scoreB = new Led({ className: 'led-big', label: '客队得分' });
    const clockLed = new Led({ className: 'led-clock-big', label: '比赛时钟' });
    const shotLed = new Led({ className: 'led-shot-big', label: '进攻时限' });
    const periodEl = h('div', { class: 'd-period' });
    const connEl = h('div', { class: 'd-conn' }, '● 直播');
    const possEl = h('div', { class: 'd-poss' });
    const bonusEl = h('div', { class: 'd-bonus', hidden: true });
    const foulA = h('div', { class: 'd-foul' });
    const foulB = h('div', { class: 'd-foul' });
    const toA = h('div', { class: 'd-timeouts' });
    const toB = h('div', { class: 'd-timeouts' });
    const nameA = h('div', { class: 'd-name' });
    const nameB = h('div', { class: 'd-name' });

    const board = h('div', { class: 'd-board' },
      h('div', { class: 'd-top' }, periodEl, h('div', { class: 'd-clock-wrap' }, clockLed.el, shotLed.el), connEl),
      h('div', { class: 'd-mid' },
        h('div', { class: 'd-team home', style: '--tc:var(--tc0)' }, nameA, foulA, toA),
        h('div', { class: 'd-center' }, scoreA.el, h('span', { class: 'd-colon' }, ':'), scoreB.el),
        h('div', { class: 'd-team away', style: '--tc:var(--tc1)' }, nameB, foulB, toB)),
      h('div', { class: 'd-bottom' }, bonusEl, possEl));

    const overlay = h('div', { class: 'd-overlay', hidden: true });
    const waitPanel = h('div', { class: 'd-wait' },
      h('p', { class: 'd-wait-code' }, code),
      h('p', { class: 'muted' }, '等待开赛——记分员在手机上点击「开始」即进入比赛'),
      h('a', { class: 'ghost', href: `/room/${code}/control`, 'data-link': true }, '打开控制端'));

    stage.append(board, overlay, waitPanel);

    function buildPanels(s) {
      stage.style.setProperty('--tc0', s.teams[0].color);
      stage.style.setProperty('--tc1', s.teams[1].color);
      nameA.textContent = s.teams[0].name;
      nameB.textContent = s.teams[1].name;
      shotLed.el.hidden = !s.config.shotClock;
    }

    function paint() {
      const s = store.state;
      if (!s) return;
      buildPanels(s);
      const d = store.clock();
      const finished = store.status === 'finished';

      waitPanel.hidden = !(store.status === 'setup' && !finished);
      board.hidden = store.status === 'setup' && !finished;

      scoreA.setText(String(s.teams[0].score));
      scoreB.setText(String(s.teams[1].score));
      const tenths = d.mode === 'game' && d.remainingMs < 60000 && !finished;
      clockLed.setText(finished ? formatClock(s.clock.remainingMs) : formatClock(d.remainingMs, tenths), { colonBlink: d.running });
      if (s.config.shotClock) shotLed.setText(String(Math.ceil((store.shot()?.remainingMs ?? 0) / 1000)).padStart(2, '0'));

      periodEl.textContent = finished ? 'FINAL'
        : d.mode === 'timeout' ? `暂停 · ${s.teams[s.clock.timeoutTeam ?? s.possession].name}`
        : d.mode === 'break' ? '节间休息'
        : `Q${d.period}${d.period > s.config.periods ? ' OT' : ''}`;

      const bonusHome = s.teams[0].fouls >= s.config.foulLimit;
      const bonusAway = s.teams[1].fouls >= s.config.foulLimit;
      foulA.textContent = `犯规 ${s.teams[0].fouls}/${s.config.foulLimit}`;
      foulB.textContent = `犯规 ${s.teams[1].fouls}/${s.config.foulLimit}`;
      foulA.classList.toggle('bonus', bonusHome);
      foulB.classList.toggle('bonus', bonusAway);
      toA.textContent = timeoutDots(s.teams[0].timeoutsLeft, s.config.timeouts);
      toB.textContent = timeoutDots(s.teams[1].timeoutsLeft, s.config.timeouts);
      bonusEl.hidden = !(bonusHome || bonusAway);
      bonusEl.textContent = bonusHome && bonusAway ? '双方 BONUS 罚球'
        : bonusHome ? `BONUS ${s.teams[0].name} 罚球` : `BONUS ${s.teams[1].name} 罚球`;
      possEl.textContent = s.possession === 0 ? `◀ 进攻 ${s.teams[0].name}` : `${s.teams[1].name} 进攻 ▶`;

      // 暂停/节间全屏倒计时
      const showOverlay = !finished && (d.mode === 'timeout' || d.mode === 'break');
      overlay.hidden = !showOverlay;
      if (showOverlay) {
        overlay.style.setProperty('--tc', d.mode === 'timeout' ? s.teams[s.clock.timeoutTeam ?? 0].color : 'var(--amber)');
        overlay.replaceChildren(
          h('p', { class: 'd-ov-title' }, d.mode === 'timeout' ? '暂停' : '节间休息'),
          h('div', { class: 'd-ov-clock' }, formatClock(d.remainingMs)),
          h('p', { class: 'd-ov-sub' }, d.mode === 'timeout' ? s.teams[s.clock.timeoutTeam ?? 0].name : `第 ${d.period} 节即将开始`));
      }

      // 归零提示音与红闪（大屏只响不写，写由控制端负责）
      if (d.zero && !zeroHandled) {
        zeroHandled = true;
        sounds.buzzer();
        stage.classList.remove('flash');
        void stage.offsetWidth;
        stage.classList.add('flash');
        setTimeout(() => stage.classList.remove('flash'), 900);
      }
      if (!d.zero) zeroHandled = false;

      // 连接状态
      connEl.textContent = store.stale() ? `信号弱 · 最后更新 ${new Date(store.lastOkAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '● 直播';
      connEl.classList.toggle('weak', store.stale());

      if (finished) {
        if (!finishedAt) { finishedAt = Date.now(); }
        overlay.hidden = false;
        overlay.style.setProperty('--tc', s.winner != null ? s.teams[s.winner].color : 'var(--amber)');
        const secs = Math.max(0, 3 - Math.floor((Date.now() - finishedAt) / 1000));
        overlay.replaceChildren(
          h('p', { class: 'd-ov-title' }, '比赛结束'),
          h('div', { class: 'd-ov-final' }, `${s.teams[0].name} ${s.teams[0].score} : ${s.teams[1].score} ${s.teams[1].name}`),
          h('a', { class: 'primary big', href: `/room/${code}/card`, 'data-link': true }, `查看数据卡（${secs}s）`));
        if (Date.now() - finishedAt > 3000) navigate(`/room/${code}/card`);
      }
    }

    const un = store.subscribe(paint);
    store.start(1000);
    const tick = setInterval(paint, 250);
    const onKey = (e) => {
      if (e.key.toLowerCase() === 'f') {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen?.().catch(() => {});
      }
      if (e.key === ' ') primeAudio();
    };
    window.addEventListener('keydown', onKey);
    stage.addEventListener('click', primeAudio, { once: true });

    return {
      cleanup() { store.stop(); un(); clearInterval(tick); window.removeEventListener('keydown', onKey); },
    };
  },
};

function timeoutDots(left, total) {
  return `暂停 ${'●'.repeat(left)}${'○'.repeat(Math.max(0, total - left))}`;
}
