'use strict';
/**
 * 重置本地数据：清空 data/ 里的医生与排班，回到「全新安装」的空状态
 * （不预设医生、诊室、科室，只保留班次时间）。
 * 不碰任何原始 Excel 文件。用法：node scripts/reset-data.js
 */
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');

const ROOT = path.join(__dirname, '..');
fs.rmSync(store.DATA_DIR, { recursive: true, force: true });
fs.rmSync(path.join(ROOT, 'data-smoke'), { recursive: true, force: true });

const roster = store.saveDoctors({ doctors: [] });
const schedule = store.saveSchedule({
  version: 1,
  settings: store.DEFAULT_SETTINGS,
  rooms: [],
  shifts: store.DEFAULT_SHIFTS.slice(),
  months: {},
});

console.log('已重置为出厂状态：');
console.log(`  医生：${roster.doctors.length} 人`);
console.log(`  诊室：${schedule.rooms.length} 个`);
console.log(`  班次：${schedule.shifts.map((s) => `${s.name} ${s.start}-${s.end}`).join('，')}`);
console.log(`  月份：${Object.keys(schedule.months).length} 个`);
console.log('提示：打开软件后到「医生资料」和「诊室设置」里建自己的名单，或用「导入旧表」导入已有排班表。');
