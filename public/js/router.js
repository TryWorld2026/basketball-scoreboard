// 极简 History 路由。视图模块从这里拿 navigate，避免与 app.js 循环引用。
let renderer = null;

export function setRenderer(fn) { renderer = fn; }
export function navigate(path) {
  history.pushState({}, '', path);
  renderer?.();
}
window.addEventListener('popstate', () => renderer?.());
