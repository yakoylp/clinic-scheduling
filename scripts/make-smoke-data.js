'use strict';
/** 建一份测试用数据（不碰真实 data/），供前端冒烟测试用。数据全部是虚构样例。 */
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const legacy = require('../lib/import-legacy');
const sample = require('../lib/legacy-sample');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'data-smoke');

// 从出厂默认状态开始，避免受 data/ 里现有内容影响（测试要可重复）
const fixture = sample.buildSampleWorkbook();
const roster = { version: 1, doctors: [] };
const schedule = {
  version: 1,
  settings: Object.assign({}, store.DEFAULT_SETTINGS, {
    deptName: fixture.department,
    triageDesk: '示例分诊台',
  }),
  rooms: store.defaultRooms(0),
  shifts: store.DEFAULT_SHIFTS.slice(),
  months: {},
};
schedule.rooms.length = 0;

const parsed = legacy.importLegacyWorkbook(fixture.file);
const applied = legacy.applyLegacyDoctors(roster, schedule.rooms, parsed);
legacy.applyLegacyMonth(schedule, applied.roster, parsed, applied.col2room);
store.reconcileMonth(schedule, parsed.ym);
// 再加一个空月份，测试「新建月份」路径
const nextYm = `${fixture.year}-${String(fixture.month + 1).padStart(2, '0')}`;
store.reconcileMonth(schedule, nextYm);

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(path.join(TMP, 'doctors.json'), JSON.stringify(applied.roster, null, 2), 'utf8');
fs.writeFileSync(path.join(TMP, 'schedule.json'), JSON.stringify(schedule, null, 2), 'utf8');
// 给测试看的元信息，避免测试里写死日期/人数
const months = Object.keys(schedule.months).sort();
const ym = parsed.ym;
fs.writeFileSync(
  path.join(TMP, 'fixture.json'),
  JSON.stringify(
    {
      ym,
      nextYm,
      months,
      filledMonths: months.filter((m) => Object.values(schedule.months[m].slots).some(Boolean)),
      rooms: schedule.rooms.length,
      doctors: applied.roster.doctors.length,
      days: store.monthDays(ym, schedule.months[ym].startDate, schedule.months[ym].endDate).length,
      nextDays: store.monthDays(nextYm, schedule.months[nextYm].startDate, schedule.months[nextYm].endDate).length,
      shifts: schedule.shifts.length,
      filled: Object.values(schedule.months[ym].slots).filter(Boolean).length,
      firstDoctor: applied.roster.doctors[0].name,
    },
    null,
    2
  ),
  'utf8'
);
console.log(`测试数据已生成：${TMP}`);
console.log(`  医生 ${applied.roster.doctors.length} 人，诊室 ${schedule.rooms.length} 个，月份 ${months.join(' ')}`);

