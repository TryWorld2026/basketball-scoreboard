// 路由与视图挂载
import { navigate, setRenderer } from './router.js';
import home from './views/home.js';
import room from './views/room.js';
import control from './views/control.js';
import display from './views/display.js';
import card from './views/card.js';

const CODE = '[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}';
const routes = [
  [new RegExp(`^\\/room\\/(${CODE})\\/control$`), control],
  [new RegExp(`^\\/room\\/(${CODE})\\/display$`), display],
  [new RegExp(`^\\/room\\/(${CODE})\\/card$`), card],
  [new RegExp(`^\\/room\\/(${CODE})$`), room],
  [/^\/$/, home],
];

const app = document.getElementById('app');
let current = null;

function render() {
  const path = location.pathname;
  for (const [re, view] of routes) {
    const m = path.match(re);
    if (!m) continue;
    current?.cleanup?.();
    app.textContent = '';
    current = view.mount(app, m.slice(1)) || {};
    document.title = view.title || '篮球计分板 · 班赛专用';
    return;
  }
  history.replaceState({}, '', '/');
  render();
}

setRenderer(render);

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});

render();
