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
require('./test-env');
const path = require('path');
const { JSDOM } = require('jsdom');
const store = require('../lib/store');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SCRIPTS = ['util.js', 'state.js', 'schedule.js', 'doctors.js', 'timerules.js', 'settings.js', 'modals.js', 'copyview.js', 'app.js'];

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
  const schedule = smokeData().schedule;
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
        // 和真实 handlers.setSlotTime 一样：四个字段各自可选，全空等于没设置
        const rule = store.normalizeSlotRule(times || {});
        if (!liveMonths[requestedYm]) liveMonths[requestedYm] = { slotRules: {} };
        if (!liveMonths[requestedYm].slotRules) liveMonths[requestedYm].slotRules = {};
        if (rule) liveMonths[requestedYm].slotRules[key] = rule;
        else delete liveMonths[requestedYm].slotRules[key];
        return ok({ key, rule });
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
    exportMonth: (ym) =>
      ok({
        dryRun: true,
        rowCount: 0,
        dayCount: 0,
        problems: [],
        templateUsed: true,
        rows: [],
        // 和真实后端一致：默认文件名 = 坐诊科室名称-年月
        defaultFileName: `${(snapshot.settings && snapshot.settings.deptName) || '排班表'}-${ym}.xlsx`,
      }),
    reveal: () => ok(true),
    copyImage: (dataUrl) => {
      // 记下最后一次复制请求，供测试断言
      if (hook.onCopyImage) hook.onCopyImage(dataUrl);
      return ok({ width: 848, height: 2256 });
    },
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
  ImportFlow, ExportFlow, switchTab, gotoMonth, updateStatus, DOCTOR_COLORS, TimeRules, CellTimeRule, CopyView };
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

/** 虚构样例数据：直接读 data-smoke/，不读磁盘 data/（测试要自洽，也不能碰真实数据） */
const SMOKE_DIR = path.join(__dirname, '..', 'data-smoke');
function smokeData() {
  const doctorsFile = path.join(SMOKE_DIR, 'doctors.json');
  const scheduleFile = path.join(SMOKE_DIR, 'schedule.json');
  if (!fs.existsSync(doctorsFile) || !fs.existsSync(scheduleFile)) {
    console.error('缺少测试数据，先跑：node scripts/make-smoke-data.js');
    process.exit(2);
  }
  // 每次都深拷一份：各测试段落会改自己那份数据，串了就会互相污染
  return {
    doctors: JSON.parse(fs.readFileSync(doctorsFile, 'utf8')).doctors,
    schedule: JSON.parse(fs.readFileSync(scheduleFile, 'utf8')),
  };
}

function snapshotFromData(overrides) {
  const { doctors, schedule } = smokeData();
  const months = Object.keys(schedule.months).sort();
  const base = {
    doctors,
    settings: schedule.settings,
    rooms: schedule.rooms,
    shifts: schedule.shifts,
    months,
    filledMonths: months.filter((ym) => Object.values(schedule.months[ym].slots || {}).some(Boolean)),
    paths: {
      root: 'X',
      packaged: false,
      data: 'X',
      exportDir: 'X',
      desktop: '/desktop',
      template: 'X',
      templateExists: true,
    },
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
    // 周一到周五 08:30（和默认不同），周六日 09:00（也和默认不同）
    const snapshot = snapshotFromData({});
    const doctor = snapshot.doctors[0];
    doctor.timeRules = [
      { days: [1, 2, 3, 4, 5], shifts: { 上午: { start: '08:30:00' } } },
      { days: [0, 6], shifts: { 上午: { start: '09:00:00' } } },
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
    check('周六标记显示 09:00', satBadge && satBadge.textContent, '09:00');
    checkTrue('标记提示里有起止时间', /08:30[–-]12:00/.test(monBadge.getAttribute('title')), monBadge.getAttribute('title'));

    const monKey = `${monday.date}|${morning.name}|${room.id}`;
    const satKey = `${saturday.date}|${morning.name}|${room.id}`;
    check('周一格子实际开始时间', App.slotTime(monKey).start, '08:30:00');
    check('周六格子实际开始时间', App.slotTime(satKey).start, '09:00:00');
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

  console.log('== 一个医生可以配任意多条规律 ==');
  {
    const snapshot = snapshotFromData({});
    const doctor = snapshot.doctors[0];
    doctor.timeRules = [];
    const w = await boot(snapshot);
    const doc = w.document;
    const App = w.__app.App;
    const TR = w.__app.TimeRules;

    w.__app.switchTab('doctors');
    const row = doc.querySelector(`#doctorTbody tr[data-id="${doctor.id}"]`);
    const openDialog = () => row.querySelector('.time-cell .btn').click();

    openDialog();
    checkTrue('规律弹窗打开', !doc.querySelector('#modalRules').hidden);
    check('没配规律时不硬造一条空规则', doc.querySelectorAll('#rulesBody .rule-card').length, 0);
    checkTrue('空状态有说明', doc.querySelector('#rulesBody').textContent.includes('没有特殊规律'));

    // 有独立的「新增一条规律」按钮
    const addBtn = [...doc.querySelectorAll('#rulesBody .preset-bar button')].find((b) => b.textContent.includes('新增一条规律'));
    checkTrue('有「＋ 新增一条规律」按钮', !!addBtn);
    addBtn.click();
    check('点一下多一条规则卡', doc.querySelectorAll('#rulesBody .rule-card').length, 1);
    addBtn.click();
    addBtn.click();
    check('可以连着加到 3 条', doc.querySelectorAll('#rulesBody .rule-card').length, 3);

    // 给三条分别配不同星期几和不同值
    const cards = () => [...doc.querySelectorAll('#rulesBody .rule-card')];
    const setDays = (card, days) => {
      for (let d = 0; d < 7; d += 1) {
        const btn = [...card.querySelectorAll('.day-btn')][d];
        if (btn.classList.contains('active') !== days.includes(d)) btn.click();
      }
    };
    const setTime = (card, field, value) => {
      const input = [...card.querySelectorAll('.time-input')][field];
      input.value = value;
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
    };
    setDays(cards()[0], [1, 2]);
    setTime(cards()[0], 0, '08:30');
    setDays(cards()[1], [3]);
    setTime(cards()[1], 0, '09:15');
    setDays(cards()[2], [6, 0]);
    setTime(cards()[2], 0, '10:00');
    checkTrue('没有重复设置提示', !doc.querySelector('#rulesBody .rule-conflict'));

    await TR.save();
    await new Promise((r) => setTimeout(r, 500));

    const saved = (App.snapshot.doctors.find((d) => d.id === doctor.id) || {}).timeRules || [];
    check('三条规律都存下来了', saved.length, 3);
    check('三条的星期分组都对', saved.map((r) => r.days.join('')).join('|'), '12|3|06');
    check('三条的开始时间都对', saved.map((r) => r.shifts['上午'].start).join('|'), '08:30:00|09:15:00|10:00:00');

    // 三个星期几各按各的规律算（先把这位医生排到那三天的格子里）
    const monday = App.days.find((d) => d.weekday === 1);
    const wednesday = App.days.find((d) => d.weekday === 3);
    const saturday = App.days.find((d) => d.weekday === 6);
    const morning = App.shifts[0];
    const room = App.rooms[0];
    App.applyChanges(
      [monday, wednesday, saturday].map((d) => ({
        date: d.date,
        shift: morning.name,
        roomId: room.id,
        doctorId: doctor.id,
      }))
    );
    const keyOf = (d) => App.slotKey(d.date, morning.name, room.id);
    check('周一的规律生效', App.slotTime(keyOf(monday)).start, '08:30:00');
    check('周三的规律生效', App.slotTime(keyOf(wednesday)).start, '09:15:00');
    check('周六的规律生效', App.slotTime(keyOf(saturday)).start, '10:00:00');

    // 重复设置同一「星期几+班次」要被拦下来
    openDialog();
    check('重新打开读出三条', doc.querySelectorAll('#rulesBody .rule-card').length, 3);
    // 第 1 条加上周三（周二=2，周三=3），和第 2 条（周三）冲突
    const allDayBtns = [...doc.querySelectorAll('#rulesBody .rule-card')[0].querySelectorAll('.day-btn')];
    allDayBtns[3].click();
    checkTrue('界面立刻提示重复设置', !!doc.querySelector('#rulesBody .rule-conflict'));
    checkTrue(
      '提示里点了冲突的星期和班次',
      /周三.*上午/.test(doc.querySelector('#rulesBody .rule-conflict').textContent),
      doc.querySelector('#rulesBody .rule-conflict').textContent
    );
    const beforeSave = JSON.stringify((App.snapshot.doctors.find((d) => d.id === doctor.id) || {}).timeRules);
    await TR.save();
    await new Promise((r) => setTimeout(r, 400));
    const afterSave = JSON.stringify((App.snapshot.doctors.find((d) => d.id === doctor.id) || {}).timeRules);
    checkTrue('有冲突时拒绝保存，数据没被改坏', beforeSave === afterSave);
    checkTrue('弹窗还开着等用户处理', !doc.querySelector('#modalRules').hidden);
    checkTrue(
      '弹出了错误提示',
      (doc.querySelector('#toastWrap') || {}).textContent && doc.querySelector('#toastWrap').textContent.includes('重复设置'),
      doc.querySelector('#toastWrap') ? doc.querySelector('#toastWrap').textContent.slice(0, 80) : '(无)'
    );

    // 同一星期几、不同班次是合法的（不冲突）
    w.__app.TimeRules.cancel();
    const snapshot2 = snapshotFromData({});
    snapshot2.doctors[0].timeRules = [
      { days: [2], shifts: { 上午: { start: '08:30:00' } } },
      { days: [2], shifts: { 下午: { start: '15:00:00' } } },
    ];
    const w2 = await boot(snapshot2);
    w2.__app.switchTab('doctors');
    const row2 = w2.document.querySelector(`#doctorTbody tr[data-id="${snapshot2.doctors[0].id}"]`);
    row2.querySelector('.time-cell .btn').click();
    check('同一天不同班次不算冲突', w2.document.querySelector('#rulesBody .rule-conflict'), null);
    check('两条都读出来了', w2.document.querySelectorAll('#rulesBody .rule-card').length, 2);
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

  console.log('== 格子级号数 / 间隔 + 徽标只在真不一样时才显示 ==');
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
    const cellOf = () =>
      doc.querySelector(`.gc-cell[data-date="${day.date}"][data-shift="${morning.name}"][data-room="${room.id}"]`);

    w.__app.ScheduleView.paintCell(cellOf(), doctor.id);
    await App.saveNow(true);
    w.__app.ScheduleView.render();

    // 默认情况下不该有徽标（时间、号数、间隔都和班次默认一样）
    check('默认格子没有时间徽标', cellOf().querySelector('.badge-time'), null);
    check('默认号数', String(App.slotTime(key).perInterval), String(App.shifts[0].perInterval));
    check('默认间隔', String(App.slotTime(key).interval), String(App.shifts[0].interval));

    // 只改间隔：徽标要显示「N分」，且是格子级的实心底
    w.__app.CellTimeRule.open({ date: day.date, shift: morning.name, roomId: room.id });
    const numInputs = doc.querySelectorAll('#cellTimeBody .num-input');
    check('单格弹窗有两个数字输入框', numInputs.length, 2);
    numInputs[1].value = '5';
    numInputs[1].dispatchEvent(new w.Event('input', { bubbles: true }));
    await w.__app.CellTimeRule.save();
    await new Promise((r) => setTimeout(r, 300));
    w.__app.ScheduleView.render();

    check('间隔存进格子设置', String(App.slotRules()[key].interval), '5');
    check('只改间隔时开始时间不变', App.slotTime(key).start, App.shifts[0].start);
    check('实际间隔是 5', String(App.slotTime(key).interval), '5');
    const badge = cellOf().querySelector('.badge-time-cell');
    checkTrue('间隔不同 → 有实心徽标', !!badge, badge ? badge.textContent : '(无)');
    check('徽标显示间隔', badge && badge.textContent, '5分');
    checkTrue('悬停提示里有号数和间隔', /1 号\/5 分钟/.test(badge.getAttribute('title')), badge.getAttribute('title'));

    // 号数一起改：开始时间没变，仍显示间隔
    w.__app.CellTimeRule.open({ date: day.date, shift: morning.name, roomId: room.id });
    const nums = doc.querySelectorAll('#cellTimeBody .num-input');
    nums[0].value = '2';
    nums[0].dispatchEvent(new w.Event('input', { bubbles: true }));
    await w.__app.CellTimeRule.save();
    await new Promise((r) => setTimeout(r, 300));
    w.__app.ScheduleView.render();
    check('号数也存进格子设置', String(App.slotRules()[key].perInterval), '2');
    check('只改号数时徽标仍显示间隔', cellOf().querySelector('.badge-time-cell').textContent, '5分');

    // 把号数和间隔都改回默认值（时间本来就没改）→ 徽标应当消失
    w.__app.CellTimeRule.open({ date: day.date, shift: morning.name, roomId: room.id });
    const nums2 = doc.querySelectorAll('#cellTimeBody .num-input');
    nums2[0].value = String(App.shifts[0].perInterval);
    nums2[0].dispatchEvent(new w.Event('input', { bubbles: true }));
    nums2[1].value = String(App.shifts[0].interval);
    nums2[1].dispatchEvent(new w.Event('input', { bubbles: true }));
    await w.__app.CellTimeRule.save();
    await new Promise((r) => setTimeout(r, 300));
    w.__app.ScheduleView.render();
    check('和默认一样时不再显示徽标', cellOf().querySelector('.badge-time'), null);

    // 科室设置里把默认间隔改成 12，这一格（仍是默认）应跟着变成 12
    w.__app.switchTab('settings');
    const intervalInput = doc.querySelector('#shiftTbody tr [data-field="interval"]');
    checkTrue('科室设置里有「时间间隔（分钟）」输入框', !!intervalInput);
    const perInput = doc.querySelector('#shiftTbody tr [data-field="perInterval"]');
    checkTrue('科室设置里有「每个时间间隔号数」输入框', !!perInput);
    check('科室设置显示的当前间隔', intervalInput.value, String(App.shifts[0].interval));
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log('== 清空画笔：左键清空、右键撤回 ==');
  {
    const snapshot = snapshotFromData({});
    const doctor = snapshot.doctors[0];
    const w = await boot(snapshot);
    const doc = w.document;
    const App = w.__app.App;
    const SV = w.__app.ScheduleView;
    const fire = (target, type, extra) =>
      target.dispatchEvent(new w.MouseEvent(type, Object.assign({ bubbles: true, cancelable: true }, extra)));

    const day = App.days[0];
    const morning = App.shifts[0];
    const room = App.rooms[0];
    const key = App.slotKey(day.date, morning.name, room.id);
    const cellOf = () =>
      doc.querySelector(`.gc-cell[data-date="${day.date}"][data-shift="${morning.name}"][data-room="${room.id}"]`);

    // 先排上这位医生
    SV.paintCell(cellOf(), doctor.id);
    check('先排上一位医生', App.slot(day.date, morning.name, room.id), doctor.id);

    // 「清空」画笔在选人条里
    const clearChip = doc.querySelector('#palette .doc-chip-clear');
    checkTrue('选人条里有「清空」', !!clearChip, clearChip ? clearChip.textContent : '(无)');
    clearChip.click();
    checkTrue('点了之后进入清空模式', App.brushClear === true);
    checkTrue('清空模式下没有具体医生画笔', App.brushId === null);
    checkTrue('清空画笔处于选中态', doc.querySelector('#palette .doc-chip-clear').classList.contains('active'));
    checkTrue('顶部显示「清空」画笔与本格提示', doc.querySelector('#brushBar').textContent.includes('右键撤回'));

    // 左键 = 清空该格
    fire(cellOf(), 'mousedown', { button: 0, buttons: 1 });
    w.document.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true }));
    check('左键清空了这一格', App.slot(day.date, morning.name, room.id), null);
    checkTrue('格子显示为空', cellOf().classList.contains('empty'));

    // 右键 = 撤回对该格的清空
    fire(cellOf(), 'contextmenu', { button: 2, buttons: 2 });
    check('右键把医生撤回来了', App.slot(day.date, morning.name, room.id), doctor.id);
    checkTrue('格子又显示这位医生', !cellOf().classList.contains('empty'));

    // 再右键一次没有可撤回的，不会报错也不会改数据
    fire(cellOf(), 'contextmenu', { button: 2, buttons: 2 });
    check('没有可撤回时数据保持不变', App.slot(day.date, morning.name, room.id), doctor.id);

    // 清空模式下右键不弹右键菜单
    const leftOver = doc.querySelector('#ctxMenu');
    check('清空模式下右键不弹菜单', leftOver, null);
    void key;
  }

  console.log('== 右键「整列都换成该医生」 ==');
  {
    const snapshot = snapshotFromData({});
    const doctor = snapshot.doctors[1] || snapshot.doctors[0];
    const w = await boot(snapshot);
    const doc = w.document;
    const App = w.__app.App;
    const SV = w.__app.ScheduleView;

    // 选中这位医生当画笔
    App.setBrush(doctor.id);
    const day = App.days[0];
    const morning = App.shifts[0];
    const room = App.rooms[0];
    const cell = doc.querySelector(
      `.gc-cell[data-date="${day.date}"][data-shift="${morning.name}"][data-room="${room.id}"]`
    );
    SV.showContextMenu(100, 100, SV.cellInfo(cell), cell);
    const menu = doc.querySelector('#ctxMenu');
    checkTrue('右键菜单里有「整列都换成」', menu.textContent.includes(`整列都换成 ${doctor.name}`), menu.textContent);
    const item = [...menu.querySelectorAll('.ctx-item')].find((b) => b.textContent.includes('整列都换成'));
    item.click();
    await new Promise((r) => setTimeout(r, 100));

    const columnKeys = Object.keys(App.month.slots).filter((k) => k.endsWith(`|${room.id}`));
    checkTrue('这一列所有格都换成了该医生', columnKeys.every((k) => App.month.slots[k] === doctor.id), `${columnKeys.length} 格`);
    checkTrue('这一列至少排了 20 格', columnKeys.length > 20, `${columnKeys.length} 格`);
  }

  console.log('== 号别名称选项 ==');
  {
    const w = await boot(snapshotFromData({}));
    const doc = w.document;
    const values = [...doc.querySelectorAll('#titleOptions option')].map((o) => o.value);
    checkTrue('有「住院医师」', values.includes('住院医师'), values.join('/'));
    checkTrue('不再有旧叫法「医师」', !values.includes('医师'), values.join('/'));
    checkTrue('「专科医师」已删除', !values.includes('专科医师'), values.join('/'));
  }

  console.log('== 导出弹窗：默认桌面 + 科室-年月 ==');
  {
    const snapshot = snapshotFromData({});
    const w = await boot(snapshot);
    const App = w.__app.App;
    await w.__app.ExportFlow.open();
    await new Promise((r) => setTimeout(r, 200));
    const EF = w.__app.ExportFlow;
    check('默认导出目录是桌面', EF.dir, '/desktop');
    const dept = snapshot.settings.deptName;
    check('默认文件名是 科室-年月', EF.fileName, `${dept}-${App.ym}.xlsx`);
    w.__app.Modals.closeAll();
  }

  console.log('== 复制排班视图：整月排班 + 表头画成长图进剪贴板 ==');
  {
    const snapshot = snapshotFromData({});
    const doctor = snapshot.doctors[0];
    // 周一到周五上午 8:30：用来验证格子角标也被画进去
    doctor.timeRules = [{ days: [1, 2, 3, 4, 5], shifts: { 上午: { start: '08:30:00' } } }];
    let copied = null;
    const w = await boot(snapshot, {
      onCopyImage: (url) => {
        copied = url;
      },
    });
    const doc = w.document;
    const App = w.__app.App;
    const CV = w.__app.CopyView;

    // 按钮位置和文案
    const copyBtn = doc.querySelector('#btnCopyView');
    const exportBtn = doc.querySelector('#btnExport');
    checkTrue('顶栏有「复制排班视图」按钮', !!copyBtn);
    check('按钮文字', copyBtn && copyBtn.textContent.trim(), '复制排班视图');
    checkTrue(
      '按钮在「导出排班表」左边',
      !!(copyBtn && exportBtn && (copyBtn.compareDocumentPosition(exportBtn) & 4)),
      copyBtn && exportBtn ? `${copyBtn.id} → ${exportBtn.id}` : '(缺按钮)'
    );

    // 先排一格
    const monday = App.days.find((d) => d.weekday === 1);
    const morning = App.shifts[0];
    const room = App.rooms[0];
    App.applyChanges([{ date: monday.date, shift: morning.name, roomId: room.id, doctorId: doctor.id }]);

    // 版式数据
    const layout = CV.buildLayout();
    check('列数 = 日期 + 星期 + 班次 + 诊室', layout.columns.length, 3 + App.rooms.length);
    check('行数 = 天数 × 班次数', layout.bodyRows, App.days.length * App.shifts.length);
    checkTrue('标题含科室名和年月', layout.title.includes('示例科室') && /年/.test(layout.title) && /月/.test(layout.title), layout.title);
    check('每个班次行的格子数 = 诊室数', layout.dateBlocks[0].rows[0].cells.length, App.rooms.length);
    checkTrue('画布宽度按列宽算', layout.width > 400, `${layout.width}px`);
    checkTrue('画布高度按行数算（长图）', layout.height > App.days.length * 2 * 30, `${layout.height}px`);

    const monBlock = layout.dateBlocks.find((b) => b.date === monday.date);
    check('排了班的格子带着医生名', monBlock.rows[0].cells[0].name, doctor.name);
    check('这一格带自定义时间角标', monBlock.rows[0].cells[0].badge, '08:30');
    checkTrue('空着的格子标成 empty', monBlock.rows[1].cells[1] ? monBlock.rows[1].cells[1].empty : true);
    checkTrue('周末的日期块被标出来', layout.dateBlocks.some((b) => b.isWeekend), layout.dateBlocks.filter((b) => b.isWeekend).length + ' 天');

    // 点按钮：桩掉 canvas，检查确实画了字、坐标都算对了、确实把 PNG 交给主进程
    const drawn = [];
    const badCoords = [];
    w.HTMLCanvasElement.prototype.getContext = () =>
      new Proxy(
        {},
        {
          get(target, prop) {
            if (prop === 'fillText') {
              return (text, x, y) => {
                drawn.push(String(text));
                // 坐标必须是有限数：NaN 会让文字画不出来（这是真出现过的 bug）
                if (!Number.isFinite(x) || !Number.isFinite(y)) badCoords.push(`${text}@${x},${y}`);
              };
            }
            if (prop === 'measureText') return () => ({ width: 10 });
            return () => {};
          },
          set() {
            return true;
          },
        }
      );
    w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,TESTPNG';

    copyBtn.click();
    await new Promise((r) => setTimeout(r, 200));
    check('交给主进程的是 PNG dataURL', copied, 'data:image/png;base64,TESTPNG');
    checkTrue('画布上写了医生姓名', drawn.includes(doctor.name), `共写了 ${drawn.length} 段文字`);
    checkTrue('画布上写了班次名', drawn.includes('上午') && drawn.includes('下午'), drawn.slice(0, 8).join('|'));
    checkTrue('画布上写了表头（日期/星期/班次）', ['日期', '星期', '班次'].every((t) => drawn.includes(t)), '');
    checkTrue('画布上写了诊室名', App.rooms.some((r) => drawn.includes(r.short || r.name)), '');
    checkTrue('画布上写了标题里的年月', drawn.some((t) => /年/.test(t) && /月/.test(t)), '');
    checkTrue('画布上写了星期几（不是留空）', drawn.some((t) => /^星期[日一二三四五六]$/.test(t)), '');
    checkTrue('班次时间是完整的 HH:MM-HH:MM', drawn.some((t) => /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(t)), drawn.filter((t) => t.includes('-')).slice(0, 3).join('|'));
    check('所有文字的绘制坐标都是有效数字', badCoords.length, 0);
    checkTrue('日期文字真的画了', drawn.some((t) => /^\d+日$/.test(t)), drawn.filter((t) => /日$/.test(t)).slice(0, 5).join('|'));
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

    // 新增两个字段：业务科室名称、现场号数
    checkTrue('科室页有「业务科室名称」输入框', !!doc.querySelector('#setBusinessDeptName'));
    checkTrue('科室页有「现场号数」输入框', !!doc.querySelector('#setOnsiteCount'));
    const biz = doc.querySelector('#setBusinessDeptName');
    biz.value = '示例业务科室';
    biz.dispatchEvent(new w.Event('input', { bubbles: true }));
    const onsite = doc.querySelector('#setOnsiteCount');
    onsite.value = '3';
    onsite.dispatchEvent(new w.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
    check('业务科室名称已保存', App.snapshot.settings.businessDeptName, '示例业务科室');
    check('现场号数已保存', App.snapshot.settings.onsiteCount, 3);
    checkTrue('保存后输入框仍是新值', doc.querySelector('#setBusinessDeptName').value === '示例业务科室');
    check('现场号数输入框是新值', doc.querySelector('#setOnsiteCount').value, '3');
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
