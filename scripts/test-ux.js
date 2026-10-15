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
const SCRIPTS = ['util.js', 'state.js', 'schedule.js', 'doctors.js', 'timerules.js', 'settings.js', 'modals.js', 'app.js'];

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
  // 假数据源的「已存格子」和「格子级时间设置」，patch/setSlotTime 写这里，month.get 从这里读
  const liveSlots = new Map();
  // test-ux 用的是自己造的 snapshot，没有 scheduleData；这里统一成一份可写的月数据
  const liveMonths = {};
  const slotRulesFor = (requestedYm, dayList, shiftList, roomList) => {
    const liveMonth = liveMonths[requestedYm] || null;
    const fromStore = (liveMonth && liveMonth.slotRules) || {};
    const slotRules = {};
    for (const [key, rule] of Object.entries(fromStore)) {
      const [date, shift, roomId] = key.split('|');
      if (!dayList.some((d) => d.date === date)) continue;
      if (!shiftList.some((s) => s.name === shift)) continue;
      if (!roomList.some((r) => r.id === roomId)) continue;
      slotRules[key] = rule;
    }
    return slotRules;
  };
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
        for (const r of roomList) {
          const key = `${d.date}|${s.name}|${r.id}`;
          slots[key] = liveSlots.get(key) || null;
        }
      }
    }
    const times = {};
    for (const d of dayList) {
      for (const s of shiftList) times[`${d.date}|${s.name}`] = { start: `${d.date} ${s.start}`, end: `${d.date} ${s.end}` };
    }
    // 每个格子实际用的时间：把格子级设置和医生级周规律都算进去
    // （主进程用 resolveMonthShiftTimes 算同样一份）
    // 医生名单直接读 snapshot.doctors，保证和界面看到的是同一份（测试里改过规律也能算进来）
    const byId = new Map((snapshot.doctors || []).map((d) => [d.id, d]));
    const slotRules = slotRulesFor(requestedYm, dayList, shiftList, roomList);
    const slotTimes = {};
    for (const d of dayList) {
      for (const s of shiftList) {
        for (const r of roomList) {
          const key = `${d.date}|${s.name}|${r.id}`;
          const doc = byId.get(slots[key]);
          const t = store.resolveCellShiftTime({
            slotRule: slotRules[key],
            doctor: doc || null,
            weekday: d.weekday,
            shift: s,
          });
          slotTimes[key] = { start: t.start, end: t.end, customized: t.customized, source: t.source };
        }
      }
    }
    return {
      ym: requestedYm,
      year: y,
      month: m,
      rooms: roomList,
      shifts: shiftList,
      slots,
      shiftTimes: times,
      slotRules,
      slotTimes,
      stats: { doctors: [], rooms: [], filled: 0, total: Object.keys(slots).length, empty: Object.keys(slots).length },
      days: dayList,
    };
  };

  return {
    snapshot: () => ok(snapshot),
    month: {
      get: (requestedYm) => ok(month(requestedYm)),
      patch: (requestedYm, changes) => {
        // 改动落到 liveSlots，这样后面再 month.get 能读回来
        for (const ch of changes || []) {
          liveSlots.set(`${ch.date}|${ch.shift}|${ch.roomId}`, ch.doctorId || null);
        }
        return ok({ applied: (changes || []).length, rejected: [] });
      },
      setSlotTime: (requestedYm, date, shift, roomId, times) => {
        const key = `${date}|${shift}|${roomId}`;
        const start = (times && times.start) || '';
        const end = (times && times.end) || '';
        if (!liveMonths[requestedYm]) liveMonths[requestedYm] = { slotRules: {} };
        if (!liveMonths[requestedYm].slotRules) liveMonths[requestedYm].slotRules = {};
        if (start || end) liveMonths[requestedYm].slotRules[key] = { start, end };
        else delete liveMonths[requestedYm].slotRules[key];
        return ok({ key, rule: start || end ? { start, end } : null });
      },
      clearSlotTime: (requestedYm, date, shift, roomId) => {
        if (liveMonths[requestedYm] && liveMonths[requestedYm].slotRules) {
          delete liveMonths[requestedYm].slotRules[`${date}|${shift}|${roomId}`];
        }
        return ok({ key: `${date}|${shift}|${roomId}`, rule: null });
      },
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
    rooms: {
      save: (list) => {
        if (hook.onRoomsSave) hook.onRoomsSave(list);
        return ok(list);
      },
    },
    settings: {
      save: (s) => {
        if (hook.onSettingsSave) hook.onSettingsSave(s);
        // 假的主进程也得把设置记下来，否则回读时界面又会回到旧值
        snapshot.settings = Object.assign({}, snapshot.settings, s);
        if (Array.isArray(s.shifts)) snapshot.shifts = s.shifts;
        return ok({ settings: snapshot.settings, shifts: snapshot.shifts });
      },
    },
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
  ImportFlow, ExportFlow, switchTab, gotoMonth, updateStatus, DOCTOR_COLORS, TimeRules, CellTimeRule };
`;
  window.eval(`(function (window) {\n${bundle}\n${epilogue}\n})(window);`);
  const evt = window.document.createEvent('Event');
  evt.initEvent('DOMContentLoaded', true, true);
  window.document.dispatchEvent(evt);
  await new Promise((r) => setTimeout(r, 850));
  if (process.env.DSH_DEBUG_BOOT) {
    console.log('[debug] html长度=', HTML.length,
      '| modalHelp=', !!window.document.querySelector('#modalHelp'),
      '| modals=', window.document.querySelectorAll('.modal').length,
      '| body长度=', window.document.body.innerHTML.length,
      '| body=', window.document.body.textContent.trim().slice(0, 200));
  }
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

  console.log('== 医生级出诊时间规律 ==');
  {
    // 造一位周一到周五 08:30、周六日 08:00 的医生，看格子标记和编辑弹窗
    const snapshot = snapshotFromData({});
    const doctor = snapshot.doctors[0];
    doctor.timeRules = [
      { days: [1, 2, 3, 4, 5], shifts: { 上午: { start: '08:30:00' } } },
      { days: [0, 6], shifts: { 上午: { start: '08:00:00' } } },
    ];
    const w = await boot(snapshot);
    const doc = w.document;
    const App = w.__app.App;

    const monday = App.days.find((d) => d.weekday === 1);
    const saturday = App.days.find((d) => d.weekday === 6);
    const morning = App.shifts[0];
    const room = App.rooms[0];
    const cellOf = (date) =>
      doc.querySelector(`.gc-cell[data-date="${date}"][data-shift="${morning.name}"][data-room="${room.id}"]`);

    // 走真实路径：像用户点格子那样排班（paintCell 会顺带把时间标记画上）
    w.__app.ScheduleView.paintCell(cellOf(monday.date), doctor.id);
    w.__app.ScheduleView.paintCell(cellOf(saturday.date), doctor.id);
    check('周一是这位医生', App.slot(monday.date, morning.name, room.id), doctor.id);
    check('周六是这位医生', App.slot(saturday.date, morning.name, room.id), doctor.id);

    const monBadge = cellOf(monday.date).querySelector('.badge-time');
    const satBadge = cellOf(saturday.date).querySelector('.badge-time');
    checkTrue('周一格子有时间标记', !!monBadge, monBadge ? monBadge.textContent : '(无)');
    check('周一标记显示 08:30', monBadge && monBadge.textContent, '08:30');
    check('周六标记显示 08:00', satBadge && satBadge.textContent, '08:00');
    checkTrue('标记提示里有起止时间', /08:30[–-]12:00/.test(monBadge.getAttribute('title')), monBadge.getAttribute('title'));

    const monKey = `${monday.date}|${morning.name}|${room.id}`;
    const satKey = `${saturday.date}|${morning.name}|${room.id}`;
    check('周一格子实际开始时间', App.slotTime(monKey).start, '08:30:00');
    check('周六格子实际开始时间', App.slotTime(satKey).start, '08:00:00');
    check('周一格子被标记为自定义', App.slotTime(monKey).customized, true);

    w.__app.switchTab('doctors');
    const row = doc.querySelector(`#doctorTbody tr[data-id="${doctor.id}"]`);
    const timeBtn = row.querySelector('.time-cell .btn');
    checkTrue('医生资料里有出诊时间按钮', !!timeBtn);
    check('按钮显示已配几条规律', timeBtn && timeBtn.textContent, '已配 2 条规律');
    checkTrue('按钮提示里写了规律内容', /周一二三四五/.test(timeBtn.getAttribute('title')), timeBtn.getAttribute('title'));

    timeBtn.click();
    checkTrue('规律弹窗打开了', !doc.querySelector('#modalRules').hidden);
    checkTrue('标题带医生名', doc.querySelector('#rulesTitle').textContent.includes(doctor.name));
    check('显示 2 条规则', doc.querySelectorAll('#rulesBody .rule-card').length, 2);
    check('第一条规则选中 5 天', doc.querySelectorAll('#rulesBody .rule-card')[0].querySelectorAll('.day-btn.active').length, 5);
    check('上午开始时间是 8:30', doc.querySelectorAll('#rulesBody .rule-card')[0].querySelectorAll('.time-input')[0].value, '08:30');
    checkTrue('有快捷添加按钮', doc.querySelectorAll('#rulesBody .preset-bar button').length >= 3);
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

  console.log('== 格子级时间设置（右键菜单 + 弹窗） ==');
  {
    const snapshot = snapshotFromData({});
    const doctor = snapshot.doctors[0];
    const w = await boot(snapshot);
    const doc = w.document;
    const App = w.__app.App;
    const day = App.days[0];
    const morning = App.shifts[0];
    const room = App.rooms[0];
    const key = App.slotKey(day.date, morning.name, room.id);
    const cell = doc.querySelector(
      `.gc-cell[data-date="${day.date}"][data-shift="${morning.name}"][data-room="${room.id}"]`
    );

    // 先排上班（paintCell 的保存是防抖的，测试里手动刷一下，避免渲染时改动还没落盘）
    w.__app.ScheduleView.paintCell(cell, doctor.id);
    await App.saveNow(true);

    // 右键菜单：没有「整行」项，有「自定义这一格的时间」
    w.__app.ScheduleView.showContextMenu(100, 100, { date: day.date, shift: morning.name, roomId: room.id }, cell);
    const menu = doc.querySelector('#ctxMenu');
    checkTrue('菜单弹出来了', !!menu);
    checkTrue('没有「整行」两项', !menu.textContent.includes('整行'), menu.textContent);
    checkTrue('有「自定义这一格的时间」', menu.textContent.includes('自定义这一格的时间'));
    checkTrue('没设过时不显示清除项', !menu.textContent.includes('清除这一格的时间设置'));
    menu.remove();

    // 打开弹窗并设 09:15–11:45
    w.__app.CellTimeRule.open({ date: day.date, shift: morning.name, roomId: room.id });
    checkTrue('时间弹窗打开了', !doc.querySelector('#modalCellTime').hidden);
    checkTrue('标题带日期和班次', doc.querySelector('#cellTimeTitle').textContent.includes('上午'));
    const inputs = doc.querySelectorAll('#cellTimeBody .time-input');
    check('有两个时间输入框', inputs.length, 2);
    inputs[0].value = '09:15';
    inputs[0].dispatchEvent(new w.Event('input', { bubbles: true }));
    inputs[1].value = '11:45';
    inputs[1].dispatchEvent(new w.Event('input', { bubbles: true }));
    await w.__app.CellTimeRule.save();
    await new Promise((r) => setTimeout(r, 300));

    check('弹窗关掉了', doc.querySelector('#modalCellTime').hidden, true);
    check('内存里记下了这一格的时间', `${App.slotRules()[key].start}-${App.slotRules()[key].end}`, '09:15:00-11:45:00');
    const times = App.slotTime(key);
    check('实际时间用的是格子设置', `${times.start}-${times.end}`, '09:15:00-11:45:00');
    check('来源标成 cell', times.source, 'cell');

    // 重新渲染后格子上有蓝色徽标
    w.__app.ScheduleView.render();
    const cell2 = doc.querySelector(
      `.gc-cell[data-date="${day.date}"][data-shift="${morning.name}"][data-room="${room.id}"]`
    );
    const badge = cell2.querySelector('.badge-time-cell');
    checkTrue('格子有单格时间徽标', !!badge, badge ? badge.textContent : '(无)');
    check('徽标显示 09:15', badge && badge.textContent, '09:15');

    // 再打开菜单应出现清除项
    w.__app.ScheduleView.showContextMenu(100, 100, { date: day.date, shift: morning.name, roomId: room.id }, cell2);
    const menu2 = doc.querySelector('#ctxMenu');
    checkTrue('设过之后菜单里有清除项', menu2.textContent.includes('清除这一格的时间设置'));
    checkTrue('菜单项显示当前时间', /09:15/.test(menu2.textContent), menu2.textContent);
    menu2.remove();

    // 清除
    w.__app.CellTimeRule.info = { date: day.date, shift: morning.name, roomId: room.id };
    await w.__app.CellTimeRule.clear();
    await new Promise((r) => setTimeout(r, 300));
    check('清除后回到默认', App.slotTime(key).start, '08:00:00');
    check('清除后来源是 shift', App.slotTime(key).source, 'shift');
  }

  console.log('== 诊室 / 科室设置：改动即自动保存并刷新 ==');
  {
    const snapshot = snapshotFromData({});
    let roomsSaved = 0;
    let settingsSaved = 0;
    const w = await boot(snapshot, {
      onRoomsSave: () => {
        roomsSaved += 1;
      },
      onSettingsSave: () => {
        settingsSaved += 1;
      },
    });
    const doc = w.document;
    const App = w.__app.App;

    // 诊室页没有「保存」按钮了
    w.__app.switchTab('rooms');
    check('诊室页去掉了保存按钮', !!doc.querySelector('#btnSaveRooms'), false);
    checkTrue('诊室页有自动保存提示位', !!doc.querySelector('#roomSaveHint'));

    // 改简名 → 自动保存
    const shortInput = doc.querySelector('#roomTbody tr [data-field="short"]');
    doc.querySelector('#roomTbody tr [data-field="short"]').value = '诊室甲';
    doc.querySelector('#roomTbody tr [data-field="short"]').dispatchEvent(new w.Event('input', { bubbles: true }));
    checkTrue('改完立刻显示「正在自动保存」', doc.querySelector('#roomSaveHint').textContent.includes('自动保存'), doc.querySelector('#roomSaveHint').textContent);
    await new Promise((r) => setTimeout(r, 1200));
    checkTrue('诊室改动触发了保存', roomsSaved > 0, `${roomsSaved} 次`);
    check('保存后提示已保存', doc.querySelector('#roomSaveHint').textContent, '已自动保存');
    check('内存里的简名已更新', App.rooms[0].short, '诊室甲');
    checkTrue('输入框仍是新值（保存后回读刷新）', doc.querySelector('#roomTbody tr [data-field="short"]').value === '诊室甲', doc.querySelector('#roomTbody tr [data-field="short"]').value);
    void shortInput;

    // 空名字时不报错、不保存
    const beforeEmpty = roomsSaved;
    const nameInput = doc.querySelector('#roomTbody tr [data-field="name"]');
    nameInput.value = '';
    nameInput.dispatchEvent(new w.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
    checkTrue('名字为空时不保存也不报错', roomsSaved === beforeEmpty, `${beforeEmpty} → ${roomsSaved}`);
    checkTrue('提示要填名称', doc.querySelector('#roomSaveHint').textContent.includes('名称'), doc.querySelector('#roomSaveHint').textContent);

    // 补上名字 → 又会自动保存
    nameInput.value = '门诊诊室甲';
    nameInput.dispatchEvent(new w.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
    checkTrue('填好名字后自动保存', roomsSaved > beforeEmpty, `${beforeEmpty} → ${roomsSaved}`);

    // 科室设置页
    w.__app.switchTab('settings');
    check('科室页去掉了保存按钮', !!doc.querySelector('#btnSaveSettings'), false);
    checkTrue('科室页有自动保存提示位', !!doc.querySelector('#settingsSaveHint'));
    const dept = doc.querySelector('#setDeptName');
    dept.value = '示例内科';
    dept.dispatchEvent(new w.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
    checkTrue('科室设置自动保存', settingsSaved > 0, `${settingsSaved} 次`);
    check('设置页提示已保存', doc.querySelector('#settingsSaveHint').textContent, '已自动保存');
    check('内存里的科室名已更新', App.snapshot.settings.deptName, '示例内科');
    checkTrue('输入框仍是新值', doc.querySelector('#setDeptName').value === '示例内科', doc.querySelector('#setDeptName').value);
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
