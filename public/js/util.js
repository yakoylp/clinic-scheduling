'use strict';
/** 通用小工具 */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of [].concat(children || [])) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

function toast(message, kind) {
  const wrap = $('#toastWrap');
  const node = el('div', { class: `toast ${kind || ''}`, text: message });
  wrap.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, kind === 'err' ? 5200 : 3000);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function currentYm() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** 把 JS 的 0..6（周日=0）转成中文星期 */
function weekdayName(jsDay) {
  return ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][jsDay] || '';
}

/** 'YYYY-MM-DD' → { year, month, day, weekday, weekdayName } */
function describeDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return {
    iso,
    year: y,
    month: m,
    day: d,
    weekday: date.getDay(),
    weekdayName: weekdayName(date.getDay()),
    isWeekend: date.getDay() === 0 || date.getDay() === 6,
  };
}

/** 给医生选的颜色，文字用白色还是深色 */
function readableText(hex) {
  const c = String(hex || '#2563eb').replace('#', '');
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? '#1f2937' : '#ffffff';
}

/** 浅色版（背景用） */
function tint(hex, alpha) {
  const c = String(hex || '#2563eb').replace('#', '');
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const a = alpha === undefined ? 0.14 : alpha;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** 调用主进程接口，失败统一抛错并提示 */
async function call(fn, ...args) {
  const res = await fn(...args);
  if (!res || res.ok !== true) {
    const message = (res && res.error) || '未知错误';
    throw new Error(message);
  }
  return res.data;
}

function confirmDialog(message, confirmText) {
  return window.confirm(message + (confirmText ? '' : ''));
}
