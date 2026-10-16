'use strict';
/**
 * 业务接口测试（不启动 Electron，直接测 lib/handlers.js）。
 * 用合成的示例工作簿，仓库里不含真实数据。
 * 用法：node scripts/test-api.js
 */
const fs = require('fs');
const os = require('os');
require('./test-env');
const path = require('path');
const handlers = require('../lib/handlers');
const store = require('../lib/store');
const sample = require('../lib/legacy-sample');

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

// 这个测试会往 data/ 里写东西，跑完要还原，免得给用户留下测试医生/测试月份
const BACKUP_DIR = path.join(os.tmpdir(), `derm-test-backup-${process.pid}`);
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const FILES = ['doctors.json', 'schedule.json'];
for (const f of FILES) {
  const src = path.join(store.DATA_DIR, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(BACKUP_DIR, f));
}
process.on('exit', () => {
  for (const f of FILES) {
    const backup = path.join(BACKUP_DIR, f);
    const target = path.join(store.DATA_DIR, f);
    try {
      if (fs.existsSync(backup)) fs.copyFileSync(backup, target);
      else fs.rmSync(target, { force: true });
    } catch (err) {
      console.log(`  还原 ${f} 失败：${err.message}`);
    }
  }
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
});

console.log('== 状态快照 ==');
const snap = handlers.snapshot();
checkTrue('快照能读出来', !!snap, JSON.stringify(snap.months));
check('导出列定义 12 列', snap.exportColumns.length, 12);
checkTrue(
  '最后两列是号数和间隔',
  snap.exportColumns.slice(10).join('|') === '每个时间间隔号数|时间间隔（分钟）',
  snap.exportColumns.slice(10).join('|')
);

// 先导一份示例数据进来，后面的用例都有东西可测
const fixture = sample.buildSampleWorkbook();
handlers.applyLegacy(fixture.file);
const afterImport = handlers.snapshot();
// 样例最后一列整列空着，导不出人来，所以入库医生会比表头名单少一位
checkTrue('导入后有医生', afterImport.doctors.length >= fixture.expectedDoctors, `${afterImport.doctors.length} 人`);
checkTrue('导入后有诊室', afterImport.rooms.length >= fixture.rooms.length, `${afterImport.rooms.length} 个`);
checkTrue('导入后有月份', afterImport.months.includes(fixture.ym), afterImport.months.join(' '));
checkTrue('filledMonths 指出哪个月有排班', afterImport.filledMonths.includes(fixture.ym), afterImport.filledMonths.join(' '));

console.log('== 新建月份 ==');
const NEW_YM = '2028-02';
handlers.deleteMonth(NEW_YM);
const created = handlers.createMonth(NEW_YM);
check('新建 2028-02', created.created, true);
const feb = handlers.getMonth(NEW_YM);
check('2028 年 2 月天数', feb.days.length, 29);
check('格子数 = 天数 × 2 班 × 诊室数', Object.keys(feb.slots).length, 29 * 2 * afterImport.rooms.length);
check('新月份全空', Object.values(feb.slots).filter(Boolean).length, 0);
check('重复新建不报错也不重建', handlers.createMonth(NEW_YM).created, false);

console.log('== 写格子 / 读回 ==');
const doctor = afterImport.doctors[0];
const room = feb.rooms[0];
const key = `${NEW_YM}-03|上午|${room.id}`;
const patch1 = handlers.patchMonth(NEW_YM, [{ date: `${NEW_YM}-03`, shift: '上午', roomId: room.id, doctorId: doctor.id }]);
check('写入 1 格', patch1.applied, 1);
check('无拒绝', patch1.rejected.length, 0);
const afterWrite = handlers.getMonth(NEW_YM);
check('读回该格', afterWrite.slots[key], doctor.id);
check('统计里的已排数', afterWrite.stats.filled, 1);
check('该医生合计', afterWrite.stats.doctors.find((d) => d.id === doctor.id).total, 1);

const patch2 = handlers.patchMonth(NEW_YM, [{ date: `${NEW_YM}-03`, shift: '上午', roomId: room.id, doctorId: doctor.id }]);
check('同值重复提交不重复计数', patch2.applied, 0);

const patch3 = handlers.patchMonth(NEW_YM, [
  { date: `${NEW_YM}-03`, shift: '上午', roomId: room.id, doctorId: 'doc_not_exist' },
  { date: `${NEW_YM}-03`, shift: '中午', roomId: room.id, doctorId: doctor.id },
]);
check('非法医生/非法班次被拒', patch3.rejected.length, 2);
check('非法改动没有落盘', patch3.applied, 0);

console.log('== 清空 ==');
handlers.clearMonth(NEW_YM, {});
const fill = [];
for (const d of [`${NEW_YM}-03`, `${NEW_YM}-04`]) {
  for (const shift of ['上午', '下午']) {
    for (const r of feb.rooms) fill.push({ date: d, shift, roomId: r.id, doctorId: doctor.id });
  }
}
handlers.patchMonth(NEW_YM, fill);
check('填充后已排数（2 天 × 2 班 × 诊室数）', handlers.getMonth(NEW_YM).stats.filled, 2 * 2 * feb.rooms.length);
check('按日期清空', handlers.clearMonth(NEW_YM, { date: `${NEW_YM}-03` }).cleared, 2 * feb.rooms.length);
check('清空后只剩一天', handlers.getMonth(NEW_YM).stats.filled, 2 * feb.rooms.length);
check('按诊室清空', handlers.clearMonth(NEW_YM, { roomId: room.id }).cleared, 2);
check('再清空一次返回 0', handlers.clearMonth(NEW_YM, { roomId: room.id }).cleared, 0);

console.log('== 月份范围 ==');
const ranged = handlers.setMonthRange(NEW_YM, `${NEW_YM}-10`, `${NEW_YM}-20`);
check('范围起点', ranged.startDate, `${NEW_YM}-10`);
const rangedMonth = handlers.getMonth(NEW_YM);
check('范围内的天数', rangedMonth.days.length, 11);
checkTrue('范围外的格子已删除', !Object.keys(rangedMonth.slots).some((k) => k.startsWith(`${NEW_YM}-03`)));

console.log('== 医生字典保存 ==');
const saved = handlers.saveDoctors([
  ...afterImport.doctors,
  { id: '', name: '测试医生', code: 'u9999', title: '医师', room: afterImport.rooms[0].name, color: '#123456', note: '' },
]);
check('新增后人数 +1', saved.length, afterImport.doctors.length + 1);
checkTrue('空 id 被自动补上', !!saved[saved.length - 1].id);
check('颜色保留', saved[saved.length - 1].color, '#123456');
check('重新读取人数一致', handlers.snapshot().doctors.length, afterImport.doctors.length + 1);

console.log('== 诊室保存的校验 ==');
let threw = '';
try {
  handlers.saveRooms([{ name: '' }]);
} catch (err) {
  threw = err.message;
}
checkTrue('空诊室名被拦下', threw.includes('不能为空'), threw);
threw = '';
try {
  handlers.saveRooms([{ name: '重复诊室' }, { name: '重复诊室' }]);
} catch (err) {
  threw = err.message;
}
checkTrue('重复诊室名被拦下', threw.includes('重复'), threw);

console.log('== 删除月份 ==');
check('删除新建的月份', handlers.deleteMonth(NEW_YM).deleted, true);
checkTrue('月份没了', !handlers.snapshot().months.includes(NEW_YM));

console.log('== 导入预览（不改数据） ==');
{
  const before = JSON.stringify(store.loadDoctors());
  const preview = handlers.previewLegacy(fixture.file);
  check('预览月份', preview.ym, fixture.ym);
  check('预览不改医生数据', JSON.stringify(store.loadDoctors()), before);

  console.log('== 导入的诊室命名（回归） ==');
  // 旧表表头写的是医生名时，诊室名必须是中性的「诊室N」，重复导入要稳定，被污染还要能自愈
  const legacyModule = require('../lib/import-legacy');
  const roster = { version: 1, doctors: [] };
  const roomList = store.defaultRooms(0);
  roomList.length = 0;
  const first = legacyModule.applyLegacyDoctors(roster, roomList, preview);
  // preview.doctors 只有真排过班的人；表头名单里那位整列空的会被当成诊室名（没有别的线索）
  check('首次导入诊室名', roomList.map((r) => r.name).join(','), '诊室1,诊室2,诊室3,示例医生D');
  checkTrue('前面的诊室名都是中性的', roomList.slice(0, 3).every((r) => /^诊室\d+$/.test(r.name)), roomList.map((r) => r.name).join(','));
  check('首次导入医生默认诊室', roster.doctors.map((d) => d.room).sort().join(','), '诊室1,诊室2,诊室3');
  const second = legacyModule.applyLegacyDoctors(roster, roomList, preview);
  check('重复导入诊室名不变', roomList.map((r) => r.name).join(','), '诊室1,诊室2,诊室3,示例医生D');
  check('重复导入医生不翻倍', roster.doctors.length, preview.doctors.length);
  check('col2room 把医生列映射到正确诊室', second.col2room.get(preview.doctors[0].name), '诊室1');

  // 诊室表被污染成医生名时，再导一次要能自愈
  const dirtyRooms = store.defaultRooms(0);
  dirtyRooms.length = 0;
  for (const [i, name] of preview.doctors.entries()) {
    dirtyRooms.push({ id: `x${i}`, name: name.name, short: name.name, order: i + 1 });
  }
  const dirtyRoster = {
    version: 1,
    doctors: preview.doctors.map((d, i) => ({ id: `x${i}`, name: d.name, room: d.name })),
  };
  legacyModule.applyLegacyDoctors(dirtyRoster, dirtyRooms, preview);
  checkTrue(
    '被污染的诊室名能自愈成中性名',
    dirtyRooms.slice(0, 3).every((r) => /^诊室\d+$/.test(r.name)),
    dirtyRooms.map((r) => r.name).join(',')
  );
}

console.log('== 导出：科室设置为空时对应列留空 ==');
{
  const schedule0 = store.loadSchedule();
  const savedSettings = JSON.parse(JSON.stringify(schedule0.settings));
  schedule0.settings = Object.assign({}, savedSettings, { deptName: '', triageDesk: '', orgName: '' });
  store.saveSchedule(schedule0);
  const built = handlers.exportMonth(fixture.ym, { dryRun: true });
  checkTrue('科室设置为空时试算仍有行', built.rowCount > 0, `${built.rowCount} 行`);
  check('坐诊科室名称为空', built.rows[0].deptName, '');
  check('分诊台名称为空', built.rows[0].triageDesk, '');
  check('试算返回默认文件名', built.defaultFileName, `号源排班-${fixture.ym}.xlsx`);
  schedule0.settings = savedSettings;
  store.saveSchedule(schedule0);
}

console.log('== 导出：指定完整文件路径 ==');
{
  const outDir = path.join(os.tmpdir(), `derm-export-${process.pid}`);
  const outFile = path.join(outDir, '自定义名字.xlsx');
  fs.rmSync(outDir, { recursive: true, force: true });
  const result = handlers.exportMonth(fixture.ym, { outDir, outFile });
  check('写到指定路径', result.file, outFile);
  checkTrue('文件确实生成了', fs.existsSync(outFile));
  checkTrue('指定的文件夹会被自动建出来', fs.existsSync(outDir));
  const again = handlers.exportMonth(fixture.ym, { outDir, outFile });
  check('同名路径允许覆盖', again.file, outFile);
  checkTrue('仍然是同一个文件', fs.existsSync(outFile));
  fs.rmSync(outDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
