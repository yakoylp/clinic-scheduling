'use strict';
/**
 * 重置本地数据：清空 data/ 里的医生与排班，回到「全新安装」的空状态
 * （不预设医生、诊室、科室，只保留班次时间）。
 *
 * 只在 data/ 已经是空的时候才直接执行；里面有数据时必须显式加 --force，
 * 而且执行前一定会先整份备份到 data.bak-<时间>/。
 * 不碰任何原始 Excel 文件。
 *
 * 用法：node scripts/reset-data.js [--force]
 */
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');

const ROOT = path.join(__dirname, '..');
const FORCE = process.argv.includes('--force') || process.argv.includes('-f');

/** 现有数据里有没有内容（医生 / 诊室 / 排班 / 改过的设置） */
function describeExisting() {
  const roster = store.loadDoctors();
  const schedule = store.loadSchedule();
  const filled = Object.values(schedule.months).reduce(
    (n, m) => n + Object.values(m.slots || {}).filter(Boolean).length,
    0
  );
  const customSettings = ['orgName', 'deptName', 'triageDesk', 'hospitalName'].filter(
    (k) => schedule.settings && String(schedule.settings[k] || '').trim()
  );
  return {
    doctors: roster.doctors.length,
    rooms: schedule.rooms.length,
    months: Object.keys(schedule.months).length,
    filled,
    customSettings,
  };
}

let backup = '';
try {
  const before = describeExisting();
  const hasData = before.doctors || before.rooms || before.months || before.filled || before.customSettings.length;

  if (hasData && !FORCE) {
    console.error('拒绝执行：data/ 里还有数据，清掉就找不回来了。');
    console.error(`  医生 ${before.doctors} 人 / 诊室 ${before.rooms} 个 / 月份 ${before.months} 个 / 已排班次 ${before.filled} 格`);
    if (before.customSettings.length) console.error(`  科室设置已填: ${before.customSettings.join('、')}`);
    console.error('');
    console.error('如果确实要清空，先备份再执行：');
    console.error('  1) 手动拷走 data/ 文件夹，或');
    console.error('  2) 重跑一次并加 --force（会自动备份到 data.bak-<时间>/）：');
    console.error('     node scripts/reset-data.js --force');
    process.exit(1);
  }

  if (hasData && FORCE && fs.existsSync(store.DATA_DIR)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    backup = path.join(ROOT, `data.bak-${stamp}`);
    fs.cpSync(store.DATA_DIR, backup, { recursive: true });
  }
} catch (err) {
  console.error(`读现有数据失败，先停下来：${err.message}`);
  process.exit(1);
}

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
if (backup) console.log(`原数据已备份到：${backup}`);
console.log('提示：打开软件后到「医生资料」和「诊室设置」里建自己的名单，或用「导入旧表」导入已有排班表。');
