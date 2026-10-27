'use strict';
/**
 * 前端冒烟测试：用 jsdom 真跑界面脚本，检查初始渲染和画笔排班是否正常。
 * 用法：node scripts/test-ui.js
 */
const fs = require('fs');
require('./test-env');
const path = require('path');
const { JSDOM } = require('jsdom');
const store = require('../lib/store');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'data-smoke');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

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

/* ---------- 假的主进程接口 ---------- */
const doctorsData = JSON.parse(fs.readFileSync(path.join(TMP, 'doctors.json'), 'utf8'));
const scheduleData = JSON.parse(fs.readFileSync(path.join(TMP, 'schedule.json'), 'utf8'));
const fixture = JSON.parse(fs.readFileSync(path.join(TMP, 'fixture.json'), 'utf8'));

const ok = (data) => Promise.resolve({ ok: true, data });

const fakeApi = {
  snapshot: () =>
    ok({
      doctors: doctorsData.doctors,
      settings: scheduleData.settings,
      rooms: scheduleData.rooms.slice().sort((a, b) => a.order - b.order),
      shifts: scheduleData.shifts,
      months: Object.keys(scheduleData.months).sort(),
      filledMonths: Object.entries(scheduleData.months)
        .filter(([, m]) => Object.values(m.slots || {}).some(Boolean))
        .map(([ym]) => ym)
        .sort(),
      paths: { root: ROOT, data: TMP, exportDir: path.join(ROOT, '导出'), template: '', templateExists: true },
      exportColumns: store.EXPORT_COLUMNS,
    }),
  month: {
    get: (ym) => {
      // 用 data-smoke 里的虚构样例，不读磁盘 data/（测试必须自洽，也不能碰真实数据）
      const roster = { doctors: doctorsData.doctors };
      const { month } = store.reconcileMonth(scheduleData, ym);
      const { year, month: mon } = store.parseYm(ym);
      return ok({
        ym,
        year,
        month: mon,
        rooms: scheduleData.rooms.slice().sort((a, b) => a.order - b.order),
        shifts: scheduleData.shifts,
        slots: month.slots,
        shiftTimes: month.shiftTimes,
        slotRules: month.slotRules || {},
        slotTimes: store.resolveMonthShiftTimes(roster.doctors, scheduleData, month),
        stats: store.computeStats(roster.doctors, month, scheduleData.rooms),
        days: store.monthDays(ym, month.startDate, month.endDate),
      });
    },
    patch: (ym, changes) => {
      const { month } = store.reconcileMonth(scheduleData, ym);
      for (const ch of changes) month.slots[`${ch.date}|${ch.shift}|${ch.roomId}`] = ch.doctorId || null;
      return ok({ applied: changes.length, rejected: [] });
    },
    setSlotTime: (ym, date, shift, roomId, times) => {
      const { month } = store.reconcileMonth(scheduleData, ym);
      if (!month.slotRules) month.slotRules = {};
      const key = `${date}|${shift}|${roomId}`;
      const start = (times && times.start) || '';
      const end = (times && times.end) || '';
      if (start || end) month.slotRules[key] = { start, end };
      else delete month.slotRules[key];
      return ok({ key });
    },
    clearSlotTime: (ym, date, shift, roomId) => {
      const { month } = store.reconcileMonth(scheduleData, ym);
      if (month.slotRules) delete month.slotRules[`${date}|${shift}|${roomId}`];
      return ok({ key: `${date}|${shift}|${roomId}` });
    },
    create: () => ok({ created: true }),
    clear: () => ok({ cleared: 0 }),
    range: () => ok({}),
  },
  doctors: { save: (list) => ok(list) },
  rooms: { save: (list) => ok(list) },
  settings: { save: (s) => ok({ settings: s, shifts: scheduleData.shifts }) },
  legacy: { pick: () => ok(null), preview: () => ok(null), apply: () => ok({}) },
  exportMonth: () => ok({ dryRun: true, rowCount: 0, dayCount: 0, problems: [], templateUsed: true, rows: [] }),
  reveal: () => ok(true),
  openFile: () => ok(true),
  openFolder: () => ok(true),
  setDirty: () => {},
  onMenu: () => {},
};

/* ---------- 造环境 ---------- */
const dom = new JSDOM(HTML, {
  url: 'file:///index.html',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});

const { window } = dom;
window.api = fakeApi;
window.confirm = () => true;
window.alert = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};

/*
 * 补一个跨脚本共享的词法作用域。
 * 浏览器里多个 <script> 共享同一个全局词法作用域，let/const 之间能互相看见；
 * 而 jsdom 的 window.eval 每次都是独立作用域，直接 eval 会报 $ is not defined。
 * 把 7 个脚本拼进同一个函数体再整体跑一遍，就还原了浏览器的行为。
 */
const scripts = ['util.js', 'state.js', 'schedule.js', 'doctors.js', 'timerules.js', 'settings.js', 'modals.js', 'app.js'];
const sources = scripts.map((name) => fs.readFileSync(path.join(ROOT, 'public', 'js', name), 'utf8'));
const epilogue = `
window.__app = { App, ScheduleView, DoctorsView, RoomsView, SettingsView, Help, Modals,
  ImportFlow, ExportFlow, switchTab, gotoMonth, stepMonth, updateStatus, describeDate, el, toast };
`;
const bundle = `(function (window) {\n${sources.join('\n;\n')}\n${epilogue}\n})(window);`;
try {
  window.eval(bundle);
} catch (err) {
  failures += 1;
  console.log(`FAIL  加载界面脚本抛异常: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
}

// 触发 DOMContentLoaded（jsdom 里手动补）
const fireReady = () => {
  const evt = window.document.createEvent('Event');
  evt.initEvent('DOMContentLoaded', true, true);
  window.document.dispatchEvent(evt);
};
fireReady();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(300);

  const doc = window.document;
  const $ = (s) => doc.querySelector(s);
  const $$ = (s) => Array.from(doc.querySelectorAll(s));

  console.log('== 启动后 DOM ==');
  checkTrue('没有出现「启动失败」', !doc.body.textContent.includes('启动失败'));
  const [fy, fm] = fixture.ym.split('-');
  check('默认打开有排班的月份', window.__app.App.ym, fixture.ym);
  check('月份选择器年', $('#selYear').value, fy);
  check('月份选择器月', $('#selMonth').value, String(Number(fm)));
  checkTrue(`网格表头有 ${fixture.rooms} 个诊室`, $$('#gridHead .gh-room').length === fixture.rooms, String($$('#gridHead .gh-room').length));
  const cells = $$('#gridScroll .gc-cell');
  const expectedCells = fixture.days * fixture.shifts * fixture.rooms;
  check(`格子总数（${fixture.days} 天 × ${fixture.shifts} 班 × ${fixture.rooms} 诊室）`, cells.length, expectedCells);
  const filled = cells.filter((c) => !c.classList.contains('empty'));
  check('已排格子数', filled.length, fixture.filled);
  // 医生按钮 + 末尾多一个「清空」画笔
  check(
    '顶部排班医生按钮数',
    $$('#palette .doc-chip').length,
    doctorsData.doctors.filter((d) => !d.archived).length + 1
  );
  checkTrue('选择条末尾有「清空」画笔', $$('#palette .doc-chip-clear').length === 1, $$('#palette').textContent);
  check('侧栏不再有医生列表', $('#palette').closest('.side') ? 1 : 0, 0);
  checkTrue('进度文字有内容', new RegExp(`\\d+ / ${expectedCells}`).test($('#progText').textContent), $('#progText').textContent);
  checkTrue('医生统计表行数等于医生数', $$('#statDoctors tbody tr').length === doctorsData.doctors.filter((d) => !d.archived).length, `${$$('#statDoctors tbody tr').length} 行`);
  checkTrue(`诊室占用表有 ${fixture.rooms} 行`, $$('#statRooms tbody tr').length === fixture.rooms);
  const demoDoc = doctorsData.doctors.find((d) => !d.code || !d.title);
  checkTrue('缺编号/号别的提醒出现', !demoDoc || $('#warnList').textContent.includes(demoDoc.name), $('#warnList').textContent.trim());

  console.log('== 画笔排班 ==');
  const App = window.__app.App;
  const firstDoc = doctorsData.doctors[0];
  const emptyCell = cells.find((c) => c.classList.contains('empty'));
  checkTrue('存在空格子', !!emptyCell, emptyCell ? emptyCell.dataset.date : '');
  const info = { date: emptyCell.dataset.date, shift: emptyCell.dataset.shift, roomId: emptyCell.dataset.room };

  // 选中医生（等价于点医生卡片）
  const before = App.stats.filled;
  App.applyChanges([{ ...info, doctorId: firstDoc.id }]);
  window.__app.ScheduleView.fillCell(
    emptyCell,
    firstDoc,
    window.__app.describeDate(info.date)
  );
  App.recalcStats();
  check('排一格后已排数 +1', App.stats.filled, before + 1);
  const upd = App.month.slots[`${info.date}|${info.shift}|${info.roomId}`];
  check('内存里记下了这位医生', upd, firstDoc.id);
  checkTrue('格子 DOM 显示了医生名', emptyCell.textContent.includes(firstDoc.name), emptyCell.textContent);

  console.log('== 撤销 / 重做 ==');
  App.undo();
  check('撤销后格子清空', App.month.slots[`${info.date}|${info.shift}|${info.roomId}`], null);
  App.redo();
  check('重做后恢复', App.month.slots[`${info.date}|${info.shift}|${info.roomId}`], firstDoc.id);

  console.log('== 保存 ==');
  App.dirty = false;
  App._pending.clear();
  App.applyChanges([{ ...info, doctorId: doctorsData.doctors[1].id }]);
  checkTrue('有改动后标记为未保存', App.dirty === true);
  await App.saveNow(true);
  check('保存后 pending 清空', App._pending.size, 0);
  check('保存后 dirty 归零', App.dirty, false);

  console.log('== 切换标签页 ==');
  window.__app.switchTab('doctors');
  checkTrue('医生页显示', $('#page-doctors').classList.contains('active'));
  check('医生表格行数', $$('#doctorTbody tr').length, doctorsData.doctors.length);
  window.__app.switchTab('rooms');
  check('诊室表格行数', $$('#roomTbody tr').length, scheduleData.rooms.length);
  window.__app.switchTab('settings');
  check('科室内码填好了', $('#setDeptName').value, scheduleData.settings.deptName);
  check('班次时间行数', $$('#shiftTbody tr').length, scheduleData.shifts.length);
  window.__app.switchTab('schedule');
  checkTrue('回到排班页', $('#page-schedule').classList.contains('active'));

  console.log('== 月份切换 ==');
  window.__app.App.ym = fixture.ym;
  await window.__app.gotoMonth(fixture.nextYm);
  check('切到下个月', window.__app.App.ym, fixture.nextYm);
  const cellsNext = $$('#gridScroll .gc-cell');
  check('下个月格子数', cellsNext.length, fixture.nextDays * fixture.shifts * fixture.rooms);
  check('下个月全空', cellsNext.filter((c) => !c.classList.contains('empty')).length, 0);

  console.log('== 右键菜单 ==');
  const target = cellsNext[0];
  const rect = { clientX: 100, clientY: 100 };
  window.__app.ScheduleView.showContextMenu(rect.clientX, rect.clientY, window.__app.ScheduleView.cellInfo(target), target);
  checkTrue('菜单弹出了', !!$('#ctxMenu'));
  const menuText = $('#ctxMenu').textContent;
  checkTrue('有清空整列', menuText.includes('整列'));
  checkTrue('去掉了没用的「整行」两项', !menuText.includes('整行'), menuText);
  checkTrue('有自定义这一格的时间', menuText.includes('自定义这一格的时间'));
  checkTrue('没设过时间时不显示清除项', !menuText.includes('清除这一格的时间设置'));
  if ($('#ctxMenu')) $('#ctxMenu').remove();

  console.log('== 说明弹窗 ==');
  window.__app.Help.show();
  checkTrue('说明弹窗打开', !$('#modalHelp').hidden);
  checkTrue('说明里有排班操作讲解', $('#helpBody').textContent.includes('拖动'));
  window.__app.Help.show('columns');
  checkTrue('列对照里有一行「号源日期」', $('#helpBody').textContent.includes('模板列'));
  window.__app.Modals.closeAll();
  checkTrue('弹窗关闭', $('#modalHelp').hidden);

  console.log('== 页脚署名 ==');
  checkTrue('页脚显示作者', doc.querySelector('.app-foot').textContent.includes('yakoylp'), doc.querySelector('.app-foot').textContent.trim());

  console.log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.log('FAIL  测试脚本异常:', err && err.stack ? err.stack : err);
  process.exit(1);
});
