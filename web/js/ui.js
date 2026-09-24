// DOM 构建助手（全部走 textContent/setAttribute，无 innerHTML 注入面）
export function h(tag, props = null, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const COLORS = [
  '#E11D2E', '#1E4FD8', '#F59E0B', '#16A34A', '#8B5CF6', '#0891B2',
  '#DB2777', '#EA580C', '#0D9488', '#4F46E5', '#B91C1C', '#CA8A04',
];

export function colorPicker(selected, onPick) {
  return h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': '队色' },
    COLORS.map((c) => h('button', {
      type: 'button',
      class: `swatch${selected === c ? ' sel' : ''}`,
      style: `--sw:${c}`,
      role: 'radio',
      'aria-checked': selected === c ? 'true' : 'false',
      'aria-label': `队色 ${c}`,
      onclick: () => onPick(c),
    })));
}
