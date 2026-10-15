'use strict';
/**
 * 医生级「出诊时间规律」测试。
 *
 * 场景就是用户提的那个：某位医生周一到周五上午 08:30 开始，周六日 08:00 开始。
 * 验证三件事：时间解析、导出取到正确时间、一个月里不同星期算出不同结果。
 *
 * 数据全部虚构。用法：node scripts/test-timerules.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/store');
const exporter = require('../lib/export');
const handlers = require('../lib/handlers');

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

const MORNING = { start: '08:00:00', end: '12:00:00' };
const AFTERNOON = { start: '14:30:00', end: '17:30:00' };

console.log('== 1. 时间解析 ==');
const special = {
  id: 'd_special',
  name: '特殊医生',
  timeRules: store.normalizeTimeRules([
    { days: [1, 2, 3, 4, 5], shifts: { 上午: { start: '08:30:00' } } },
    { days: [0, 6], shifts: { 上午: { start: '08:00:00' } } },
  ]),
};
const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const expectedStart = { 0: '08:00:00', 1: '08:30:00', 2: '08:30:00', 3: '08:30:00', 4: '08:30:00', 5: '08:30:00', 6: '08:00:00' };
for (const d of [0, 1, 3, 5, 6]) {
  const t = store.effectiveShiftTime(special, d, '上午', MORNING);
  check(`  ${names[d]}上午开始时间`, t.start, expectedStart[d]);
  check(`  ${names[d]}上午结束时间（没配就沿用班次）`, t.end, '12:00:00');
  checkTrue(`  ${names[d]}被标记为自定义`, t.customized === true);
}
const plain = { id: 'd_plain', name: '普通医生' };
const plainT = store.effectiveShiftTime(plain, 3, '上午', MORNING);
check('没配规律的医生用班次默认', `${plainT.start}-${plainT.end}`, '08:00:00-12:00:00');
check('没配规律时不标自定义', plainT.customized, false);
check('下午没配到时用班次默认', store.effectiveShiftTime(special, 3, '下午', AFTERNOON).start, '14:30:00');

console.log('== 2. 时间写法容错 ==');
check('8:30 → 08:30:00', store.normalizeClock('8:30'), '08:30:00');
check('08:30 → 08:30:00', store.normalizeClock('08:30'), '08:30:00');
check('非法 25:00 → 空', store.normalizeClock('25:00'), '');
const dirty = store.normalizeTimeRules([
  { days: [1, 1, 9, -1], shifts: { 上午: { start: '8:30' } } },
  { days: [], shifts: { 上午: { start: '08:00' } } },
  { days: [0], shifts: {} },
  'junk',
]);
check('脏数据被过滤后只剩 1 条', dirty.length, 1);
check('重复/越界的星期被清理', dirty[0].days.join(','), '1');

console.log('== 3. 一周七天全排的实际情况 ==');
{
  // 造一个 2026-10 的排班：一位特殊医生，一个诊室，上午下午每天都排
  const M = '2026-10';
  const schedule = {
    version: 1,
    settings: Object.assign({}, store.DEFAULT_SETTINGS, { deptName: '示例科室' }),
    rooms: [{ id: 'room1', name: '诊室1', short: '诊室1', order: 1 }],
    shifts: store.DEFAULT_SHIFTS.slice(),
    months: {},
  };
  // buildEmptyMonth 只造骨架，要 reconcileMonth 才会把格子按诊室和日期铺出来
  store.reconcileMonth(schedule, M);
  const month = schedule.months[M];
  checkTrue('整月格子已铺开', Object.keys(month.slots).length === 31 * 2, `${Object.keys(month.slots).length} 格`);
  for (const key of Object.keys(month.slots)) month.slots[key] = 'd_special';
  const doctor = Object.assign({}, special, { code: 'doctor001', title: '医师', room: '诊室1', color: '#2563eb' });

  const rows = exporter.buildRows({ doctors: [doctor] }, schedule, M, { deptName: '示例科室' }).rows;
  const wd = (date) => new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))).getDay();
  const morningRows = rows.filter((r) => r.shift === '上午');
  const weekendRows = morningRows.filter((r) => wd(r.date) === 0 || wd(r.date) === 6);
  const weekdayRows = morningRows.filter((r) => wd(r.date) >= 1 && wd(r.date) <= 5);
  checkTrue('周末上午 08:00 开始', weekendRows.every((r) => r.start.endsWith('08:00:00')), `${weekendRows.length} 天`);
  checkTrue('工作日（周一~五）上午 08:30 开始', weekdayRows.every((r) => r.start.endsWith('08:30:00')), `${weekdayRows.length} 天`);
  check('上午一共 31 天', morningRows.length, 31);
  check('周末天数 + 工作日天数 = 全月', weekendRows.length + weekdayRows.length, 31);
  check('周末天数', weekendRows.length, 9);
  check('工作日天数', weekdayRows.length, 22);
  checkTrue('同一天的上午下午用各自班次时间', rows.filter((r) => r.shift === '下午').every((r) => r.start.endsWith('14:30:00')));
  const row2026_10_03 = rows.find((r) => r.date === '2026-10-03' && r.shift === '上午');
  const row2026_10_05 = rows.find((r) => r.date === '2026-10-05' && r.shift === '上午');
  check('10-03（周六）上午', row2026_10_03.start, '2026-10-03 08:00:00');
  check('10-05（周一）上午', row2026_10_05.start, '2026-10-05 08:30:00');
  console.log('  抽样：', row2026_10_03.start, '|', row2026_10_05.start);

  console.log('== 4. 同一天同一班次，不同医生各自的时间 ==');
  // 10-05 上午本来是特殊医生 08:30，再加一间诊室放普通医生，两者应各按各的时间
  schedule.rooms.push({ id: 'room2', name: '诊室2', short: '诊室2', order: 2 });
  store.reconcileMonth(schedule, M);
  const plainDoctor = { id: 'd_plain', name: '普通医生', code: 'doctor002', title: '医师', room: '诊室2', color: '#db2777' };
  month.slots['2026-10-05|上午|room2'] = 'd_plain';
  const mixed = exporter.buildRows({ doctors: [doctor, plainDoctor] }, schedule, M, {}).rows;
  const specialRow = mixed.find((r) => r.date === '2026-10-05' && r.shift === '上午' && r.doctor === '特殊医生');
  const plainRow = mixed.find((r) => r.date === '2026-10-05' && r.shift === '上午' && r.doctor === '普通医生');
  check('特殊医生 周一 08:30', specialRow && specialRow.start, '2026-10-05 08:30:00');
  check('普通医生同一天同一班次仍是 08:00', plainRow && plainRow.start, '2026-10-05 08:00:00');
  check('两行诊室不同', `${specialRow && specialRow.room}|${plainRow && plainRow.room}`, '诊室1|诊室2');
}

console.log('== 5. 通过 handlers 存医生后再读，规律不丢 ==');
{
  const BACKUP = path.join(os.tmpdir(), `derm-timerule-backup-${process.pid}`);
  fs.mkdirSync(BACKUP, { recursive: true });
  const FILES = ['doctors.json', 'schedule.json'];
  for (const f of FILES) {
    const src = path.join(store.DATA_DIR, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(BACKUP, f));
  }
  const restore = () => {
    for (const f of FILES) {
      const b = path.join(BACKUP, f);
      const t = path.join(store.DATA_DIR, f);
      if (fs.existsSync(b)) fs.copyFileSync(b, t);
      else fs.rmSync(t, { force: true });
    }
    fs.rmSync(BACKUP, { recursive: true, force: true });
  };
  try {
    const saved = handlers.saveDoctors([
      { id: '', name: '甲乙丙丁', code: 'doctor003', title: '医师', room: '', color: '#16a34a', timeRules: special.timeRules },
    ]);
    check('保存后规则条数', saved[0].timeRules.length, 2);
    const reloaded = handlers.snapshot().doctors.find((d) => d.name === '甲乙丙丁');
    check('重新读取仍有 2 条规则', reloaded.timeRules.length, 2);
    check('规则里的时间被规范化', reloaded.timeRules[0].shifts['上午'].start, '08:30:00');
    check('规则里的星期被规范化', reloaded.timeRules[0].days.join(','), '1,2,3,4,5');

    // 通过 getMonth 拿到的 slotTimes 要给界面用
    handlers.createMonth('2026-12');
    const m = handlers.getMonth('2026-12');
    checkTrue('getMonth 返回了 slotTimes', !!m.slotTimes, `${Object.keys(m.slotTimes || {}).length} 个格子`);
  } finally {
    restore();
  }
}

console.log('== 6. 格子级时间设置（优先级最高） ==');
{
  const shift = { name: '上午', start: '08:00:00', end: '12:00:00' };
  const doctor = { name: '有规律的医生', timeRules: [{ days: [1, 2, 3, 4, 5], shifts: { 上午: { start: '08:30:00' } } }] };

  const r1 = store.resolveCellShiftTime({ doctor, weekday: 1, shift });
  check('只有医生规律时用医生的', `${r1.start}-${r1.end}`, '08:30:00-12:00:00');
  check('来源是 doctor', r1.source, 'doctor');

  const r2 = store.resolveCellShiftTime({ slotRule: { start: '09:00:00', end: '' }, doctor, weekday: 1, shift });
  check('格子设置盖过医生规律', `${r2.start}-${r2.end}`, '09:00:00-12:00:00');
  check('来源是 cell', r2.source, 'cell');

  const r3 = store.resolveCellShiftTime({ slotRule: { start: '10:00:00', end: '11:00:00' }, weekday: 0, shift });
  check('没有医生规律时格子设置照样生效', `${r3.start}-${r3.end}`, '10:00:00-11:00:00');

  const r4 = store.resolveCellShiftTime({ weekday: 0, shift });
  check('什么都没设就用班次默认', `${r4.start}-${r4.end}`, '08:00:00-12:00:00');
  check('来源是 shift', r4.source, 'shift');
  check('班次默认时不算自定义', r4.customized, false);

  check('空的格子设置等于没设置', store.normalizeSlotRule({ start: '', end: '' }), null);
  check('简写时间会被补全', JSON.stringify(store.normalizeSlotRule({ start: '9:00', end: '' })), '{"start":"09:00:00","end":""}');
  check('只填结束时间也保留', JSON.stringify(store.normalizeSlotRule({ start: '', end: '11:30' })), '{"start":"","end":"11:30:00"}');
}

console.log('== 7. handlers 存 / 清格子时间，并且导出用得上 ==');
{
  const BACKUP = path.join(os.tmpdir(), `derm-slotrule-backup-${process.pid}`);
  fs.mkdirSync(BACKUP, { recursive: true });
  const FILES = ['doctors.json', 'schedule.json'];
  for (const f of FILES) {
    const src = path.join(store.DATA_DIR, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(BACKUP, f));
  }
  try {
    // 一个诊室、一位无规律的医生，整月上午都排他
    const rooms = handlers.saveRooms([{ name: '诊室1', short: '诊室1' }]);
    const docs = handlers.saveDoctors([
      { id: '', name: '普通医生', code: 'doctor001', title: '医师', room: rooms[0].name, color: '#2563eb' },
    ]);
    const M = '2027-05';
    handlers.createMonth(M);
    const target = `${M}-04`; // 2027-05-04 是周二
    handlers.patchMonth(M, [{ date: target, shift: '上午', roomId: rooms[0].id, doctorId: docs[0].id }]);

    const before = handlers.getMonth(M);
    check('没设格子时间时用班次默认', before.slotTimes[`${target}|上午|${rooms[0].id}`].start, '08:00:00');
    check('source 是 shift', before.slotTimes[`${target}|上午|${rooms[0].id}`].source, 'shift');

    // 设这一格为 09:15–11:45
    handlers.setSlotTime(M, target, '上午', rooms[0].id, { start: '09:15:00', end: '11:45:00' });
    const after = handlers.getMonth(M);
    check('格子时间生效', `${after.slotTimes[`${target}|上午|${rooms[0].id}`].start}-${after.slotTimes[`${target}|上午|${rooms[0].id}`].end}`, '09:15:00-11:45:00');
    check('slotRules 里有这一格', !!after.slotRules[`${target}|上午|${rooms[0].id}`], true);
    check('只影响这一格（同一天别的诊室没有）', Object.keys(after.slotRules).length, 1);

    // 导出的这一行要用格子时间
    const roster = handlers.snapshot();
    const schedule = store.loadSchedule();
    const rows = exporter.buildRows({ doctors: roster.doctors }, schedule, M, {}).rows;
    const row = rows.find((r) => r.date === target && r.shift === '上午');
    check('导出行开始时间', row.start, `${target} 09:15:00`);
    check('导出行结束时间', row.end, `${target} 11:45:00`);

    // 清除
    handlers.clearSlotTime(M, target, '上午', rooms[0].id);
    const cleared = handlers.getMonth(M);
    check('清除后回到班次默认', cleared.slotTimes[`${target}|上午|${rooms[0].id}`].start, '08:00:00');
    check('清除后 slotRules 里没了', !!cleared.slotRules[`${target}|上午|${rooms[0].id}`], false);

    // 越界的格子要报错
    let threw = '';
    try {
      handlers.setSlotTime(M, '2027-05-99', '上午', rooms[0].id, { start: '09:00:00' });
    } catch (err) {
      threw = err.message;
    }
    checkTrue('不存在的格子会被拒绝', threw.includes('排班范围'), threw);
  } finally {
    for (const f of FILES) {
      const b = path.join(BACKUP, f);
      const t = path.join(store.DATA_DIR, f);
      if (fs.existsSync(b)) fs.copyFileSync(b, t);
      else fs.rmSync(t, { force: true });
    }
    fs.rmSync(BACKUP, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
