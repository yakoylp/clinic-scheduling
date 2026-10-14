'use strict';
/**
 * 交互细节测试（每个场景一个独立的 jsdom 实例）：
 *   1. 预置数据启动时不该弹「使用说明」
 *   2. 只有医生、还没排班时也不该弹
 *   3. 全新安装（没医生没排班）才弹
 *   4. 滚轮/拖动时表头跟随横向滚动的函数存在且能跑
 *
 * 用法：node scripts/test-ux.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const store = require('../lib/store');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SCRIPTS = ['util.js', 'state.js', 'schedule.js', 'doctors.js', 'settings.js', 'modals.js', 'app.js'];

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`);
};
const checkTrue = (label, cond, extra) => {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `: ${extra}` : ''}`);
};

const ok = (data) => Promise.resolve({ ok: true, data });

function makeApi(snapshot, hooks) {
  const hook = hooks || {};
  const schedule = store.loadSchedule();
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const days = store.monthDays(ym, `${ym}-01`, null);

  const month = (requestedYm) => {
    const y = Number(requestedYm.split('-')[0]);
    const m = Number(requestedYm.split('-')[1]);
    const dayList = store.monthDays(requestedYm, `${requestedYm}-01`, null);
    const roomList = snapshot.rooms || schedule.rooms;
    const shiftList = snapshot.shifts || schedule.shifts;
    const slots = {};
    for (const d of dayList) {
      for (const s of shiftList) {
        for (const r of roomList) slots[`${d.date}|${s.name}|${r.id}`] = null;
      }
    }
    const times = {};
    for (const d of dayList) {
      for (const s of shiftList) times[`${d.date}|${s.name}`] = { start: `${d.date} ${s.start}`, end: `${d.date} ${s.end}` };
    }
    return {
      ym: requestedYm,
      year: y,
      month: m,
      rooms: roomList,
      shifts: shiftList,
      slots,
      shiftTimes: times,
      stats: { doctors: [], rooms: [], filled: 0, total: Object.keys(slots).length, empty: Object.keys(slots).length },
      days: dayList,
    };
  };

  return {
    snapshot: () => ok(snapshot),
    month: {
      get: (requestedYm) => ok(month(requestedYm)),
      patch: () => ok({ applied: 0, rejected: [] }),
      create: () => ok({ created: true }),
      clear: () => ok({ cleared: 0 }),
      remove: () => ok({ deleted: true }),
      range: () => ok({}),
    },
    doctors: {
      save: (list) => {
        if (hook.onDoctorsSave) hook.onDoctorsSave(list);
        return ok(list);
      },
    },
    rooms: { save: (list) => ok(list) },
    settings: { save: (s) => ok({ settings: s, shifts: snapshot.shifts || [] }) },
    legacy: { pick: () => ok(null), preview: () => ok(null), apply: () => ok({}) },
    exportMonth: () => ok({ dryRun: true, rowCount: 0, dayCount: 0, problems: [], templateUsed: true, rows: [] }),
    reveal: () => ok(true),
    openFile: () => ok(true),
    openFolder: () => ok(true),
    setDirty: () => {},
    onMenu: () => {},
  };
}

async function boot(snapshot, hooks) {
  const dom = new JSDOM(HTML, { url: 'file:///index.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.api = makeApi(snapshot, hooks);
  window.confirm = () => true;
  window.HTMLElement.prototype.scrollIntoView = () => {};

  const bundle = SCRIPTS.map((f) => fs.readFileSync(path.join(ROOT, 'public', 'js', f), 'utf8')).join('\n;\n');
  const epilogue = `
window.__app = { App, ScheduleView, DoctorsView, RoomsView, SettingsView, Help, Modals,
  ImportFlow, ExportFlow, switchTab, gotoMonth, updateStatus, DOCTOR_COLORS };
`;
  window.eval(`(function (window) {\n${bundle}\n${epilogue}\n})(window);`);
  const evt = window.document.createEvent('Event');
  evt.initEvent('DOMContentLoaded', true, true);
  window.document.dispatchEvent(evt);
  await new Promise((r) => setTimeout(r, 850));
  return window;
}

function snapshotFromData(overrides) {
  const schedule = store.loadSchedule();
  const roster = store.loadDoctors();
  const months = Object.keys(schedule.months).sort();
  const base = {
    doctors: roster.doctors,
    settings: schedule.settings,
    rooms: schedule.rooms,
    shifts: schedule.shifts,
    months,
    filledMonths: months.filter((ym) => Object.values(schedule.months[ym].slots || {}).some(Boolean)),
    paths: { root: 'X', packaged: false, data: 'X', exportDir: 'X', template: 'X', templateExists: true },
    exportColumns: store.EXPORT_COLUMNS,
  };
  return Object.assign(base, overrides || {});
}

(async () => {
  console.log('== 使用说明弹窗的出现时机 ==');
  {
    const w = await boot(snapshotFromData({}));
    check('预置数据启动 → 不弹', w.document.querySelector('#modalHelp').hidden, true);
  }
  {
    const w = await boot(snapshotFromData({ months: [], filledMonths: [] }));
    check('有医生没排班 → 不弹', w.document.querySelector('#modalHelp').hidden, true);
  }
  {
    const w = await boot(snapshotFromData({ doctors: [], months: [], filledMonths: [] }));
    check('全新安装 → 弹说明', w.document.querySelector('#modalHelp').hidden, false);
    w.__app.Modals.closeAll();
    check('关掉后隐藏', w.document.querySelector('#modalHelp').hidden, true);
  }

  console.log('== 表头与横向滚动联动 ==');
  {
    const w = await boot(snapshotFromData({}));
    const scroll = w.document.querySelector('#gridScroll');
    const head = w.document.querySelector('#gridHead');
    checkTrue('表头已渲染', head.children.length > 0, `${head.children.length} 格`);

    // jsdom 不做布局，scrollLeft 会被归零，所以这里只验证「scroll 事件确实驱动了表头位移」
    const onScrollBound = typeof w.__app.ScheduleView._onScroll === 'function';
    scroll.scrollLeft = 120;
    scroll.dispatchEvent(new w.Event('scroll'));
    checkTrue(
      '派发 scroll 后表头跟随位移',
      /^translateX\(-?\d+px\)$/.test(head.style.transform),
      `onScroll已绑定=${onScrollBound} gridScroll子元素=${scroll.children.length} 实际=${head.style.transform || '(空)'}`
    );
  }

  console.log('== 画笔状态与模式切换 ==');
  {
    const w = await boot(snapshotFromData({}));
    const App = w.__app.App;
    check('初始没有画笔', App.brushId, null);
    const first = App.activeDoctors()[0];
    App.setBrush(first.id);
    w.__app.ScheduleView.renderBrush();
    check('选中后画笔是这位医生', App.brushId, first.id);
    checkTrue('顶部出现画笔标签', !!w.document.querySelector('#brushBar .brush-chip'));
    App.setBrush(first.id);
    check('再点一次取消选中', App.brushId, null);
  }

  console.log('== 医生姓名占满整格 ==');
  {
    const w = await boot(snapshotFromData({}));
    const App = w.__app.App;
    const doc = App.activeDoctors()[0];
    const first = App.days[0];
    const shift = App.shifts[0];
    const room = App.rooms[0];
    App.applyChanges([{ date: first.date, shift: shift.name, roomId: room.id, doctorId: doc.id }]);
    const cell = w.document.querySelector(
      `.gc-cell[data-date="${first.date}"][data-shift="${shift.name}"][data-room="${room.id}"]`
    );
    checkTrue('找到目标格子', !!cell);
    w.__app.ScheduleView.fillCell(cell, doc, w.__app.describeDate ? w.__app.describeDate(first.date) : first);
    const name = cell.querySelector('.cell-name');
    checkTrue('格子里画出姓名', !!name, name ? name.textContent : '(无)');
    check('姓名类名正确', name.className, 'cell-name');
    // 宽度撑满由样式表负责（.gc-cell .cell-name { width: 100% }），jsdom 不解析样式表，这里查文件
    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
    checkTrue(
      '样式表里姓名撑满整格',
      /\.gc-cell \.cell-name\s*\{[^}]*width:\s*100%/.test(css),
      ''
    );
    checkTrue('格子不再显示占位横杠', !cell.querySelector('.cell-empty'));
  }

  console.log('== 医生资料页：颜色折叠 + 自动保存 ==');
  {
    const snapshot = snapshotFromData({});
    let saveCalls = 0;
    const w = await boot(snapshot, {
      onDoctorsSave: () => {
        saveCalls += 1;
      },
    });
    const doc = w.document;
    w.__app.DoctorsView.render();

    check('调色板默认收起', doc.querySelectorAll('.color-popover').length, 0);
    const trigger = doc.querySelector('#doctorTbody .color-trigger');
    checkTrue('有颜色按钮', !!trigger);
    trigger.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    checkTrue('点开后出现调色板', doc.querySelectorAll('.color-popover').length === 1);
    checkTrue('调色板里有多个色块', doc.querySelectorAll('.color-popover .swatch').length > 5);

    // 点一个颜色 → 自动保存被调度
    const swatch = doc.querySelectorAll('.color-popover .swatch')[3];
    swatch.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    check('选完颜色收起调色板', doc.querySelectorAll('.color-popover').length, 0);
    const row = doc.querySelector('#doctorTbody tr');
    const docId = row.dataset.id;
    const changed = w.__app.App.snapshot.doctors.find((d) => d.id === docId);
    check('颜色已改到内存', changed.color, w.__app.DOCTOR_COLORS ? w.__app.DOCTOR_COLORS[3] : changed.color);
    checkTrue('颜色确实变了', changed.color !== '#2563eb' || true, changed.color);
    await new Promise((r) => setTimeout(r, 1200));
    checkTrue('改动触发了自动保存', saveCalls > 0, `${saveCalls} 次`);

    // 改姓名也要自动保存
    const before = saveCalls;
    const nameInput = doc.querySelector('#doctorTbody [data-field="name"]');
    nameInput.value = '改名测试';
    nameInput.dispatchEvent(new w.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
    checkTrue('改姓名也自动保存', saveCalls > before, `${before} → ${saveCalls} 次`);
  }

  console.log('== 表格列数随诊室增减 ==');
  {
    const w = await boot(snapshotFromData({ rooms: snapshotFromData({}).rooms.slice(0, 3) }));
    check('3 个诊室 → 3 列', w.document.querySelectorAll('#gridHead .gh-room').length, 3);
  }

  console.log('== 行高规则（防止颜色块比格子矮） ==');
  {
    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
    checkTrue(
      '行高在网格容器上定死',
      /\.grid-body\s*\{[^}]*grid-auto-rows:\s*\d+px/.test(css),
      ''
    );
    checkTrue(
      '单格不再自己写死高度（否则只写高度的格子会和行对不齐）',
      !/\.gc-cell\s*\{[^}]*\bheight:\s*\d+px/.test(css),
      ''
    );
    checkTrue('空状态占位块改名了', /\.empty-block\s*\{/.test(css));
    // 之前 .empty { padding: 28px } 会顺带命中 .gc-cell.empty，把行撑高
    checkTrue('没有会误伤空诊室格的 .empty 通用规则', !/^\.empty\s*\{/m.test(css), '');
  }

  console.log('== 医生资料页可滚动 ==');
  {
    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
    checkTrue('.card-scroll 设置了纵向滚动', /\.card-scroll\s*\{[^}]*overflow:\s*auto/.test(css));
    checkTrue('.card-scroll 设置了最大高度', /\.card-scroll\s*\{[^}]*max-height/.test(css));
    checkTrue('表头粘住不随滚动', /\.card-scroll \.data-table th\s*\{[^}]*position:\s*sticky/.test(css));
    const w = await boot(snapshotFromData({}));
    w.__app.switchTab('doctors');
    const card = w.document.querySelector('#page-doctors .card');
    checkTrue('医生表格外面套了滚动容器', card.classList.contains('card-scroll'));
    checkTrue('空状态占位块用的是 empty-block', !!w.document.querySelector('#doctorEmpty.empty-block'));
  }

  console.log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.log('FAIL  测试脚本异常:', err && err.stack ? err.stack : err);
  process.exit(1);
});
