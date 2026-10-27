'use strict';
/**
 * 端到端验证：导入旧式排班表 → 落库 → 统计 → 生成导出行 → 写出 xlsx → 复核内容与样式。
 *
 * 用 lib/legacy-sample.js 现场造的虚构样例表，仓库里不含任何真实医院数据。
 * 会重置 data/，跑完后 data/ 里就是这份样例数据。
 *
 * 用法：node scripts/test-export.js [样例工作簿路径] [导出目录]
 */
require('./test-env');
const path = require('path');
const fs = require('fs');
const store = require('../lib/store');
const legacy = require('../lib/import-legacy');
const exporter = require('../lib/export');
const sample = require('../lib/legacy-sample');

const ROOT = path.join(__dirname, '..');
// 导出目录默认走 test-env 指定的临时目录，别往工程的 导出/ 里写
const OUT_DIR = process.argv[3] || require('./test-env').outDir;

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`);
}
function checkTrue(label, cond, extra) {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `: ${extra}` : ''}`);
}

// 干净重来，并用虚构样例表作为数据源
const fixture = sample.buildSampleWorkbook();
const LEGACY_FILE = process.argv[2] || fixture.file;
fs.rmSync(store.DATA_DIR, { recursive: true, force: true });

console.log('== 1. 导入示例排班表 ==');
checkTrue('样例表已生成', fs.existsSync(LEGACY_FILE), LEGACY_FILE);
const parsed = legacy.importLegacyWorkbook(LEGACY_FILE);
console.log(`  月份=${parsed.ym} 日期数=${parsed.days.length} 有排班的格=${Object.keys(parsed.assignments).length}`);
console.log('  诊室列 → 常驻医生：');
parsed.rooms.forEach((r) => console.log(`    ${r.name} → ${r.doctor || '(空)'}`));
parsed.warnings.forEach((w) => console.log('    warn:', w));
parsed.anomalies.slice(0, 5).forEach((a) => console.log('    anomaly:', a));
check('识别月份', parsed.ym, fixture.ym);
check('日期数', parsed.days.length, fixture.dateCount);
// 样例最后一列是整列空着的，所以只会认出前面几位常驻医生
check('医生数', parsed.doctors.length, fixture.expectedDoctors);
check('首日', parsed.days[0], `${fixture.ym}-01`);
checkTrue('认出了常驻医生', parsed.doctors.length > 0, parsed.doctors.map((d) => d.name).join('/'));
checkTrue('至少有一列没认出常驻医生（整列空着那种）', parsed.rooms.some((r) => !r.doctor), parsed.rooms.map((r) => `${r.name}:${r.doctor || '空'}`).join(' '));

console.log('== 2. 落库（医生字典 + 月度排班） ==');
const roster = store.loadDoctors();
const schedule = store.loadSchedule();
schedule.settings = Object.assign({}, schedule.settings, {
  deptName: fixture.department,
  triageDesk: '示例分诊台',
});
const applied = legacy.applyLegacyDoctors(roster, schedule.rooms, parsed);
store.saveDoctors(applied.roster);
const monthResult = legacy.applyLegacyMonth(schedule, applied.roster, parsed, applied.col2room);
store.saveSchedule(schedule);

// 号别名称迁移：把一位医生的号别写成旧叫法「医师」，保存后应自动变成「住院医师」
applied.roster.doctors[0].title = '医师';
store.saveDoctors(applied.roster);
const rosterMigrated = store.loadDoctors();
check('旧叫法「医师」自动迁移成「住院医师」', rosterMigrated.doctors[0].title, '住院医师');
check('迁移后不再有「医师」', rosterMigrated.doctors.filter((d) => d.title === '医师').length, 0);
// 后续导出用迁移后的医生字典，和真实运行路径一致
applied.roster.doctors = rosterMigrated.doctors;
check('诊室数', schedule.rooms.length, fixture.rooms.length);
check('出厂不预设医生，导入后正好是认出来的人数', applied.roster.doctors.length, fixture.expectedDoctors);
checkTrue(
  '新增医生姓名与认出来的列一致',
  parsed.doctors.every((d) => applied.roster.doctors.some((x) => x.name === d.name)),
  applied.roster.doctors.map((d) => d.name).join('/')
);
applied.roster.doctors.forEach((d) => console.log(`    ${d.name}  编码=${d.code || '(空)'}  号别=${d.title || '(空)'}  诊室=${d.room}`));

console.log('== 3. 统计 ==');
const stats = store.computeStats(applied.roster.doctors, monthResult.month, schedule.rooms);console.log('  医生班次：', stats.doctors.map((d) => `${d.name}=${d.total}`).join(' '));
console.log('  诊室占用：', stats.rooms.map((r) => `${r.short}=${r.filled}`).join(' '));
check('已排格数 = 样例里填了人的格数', stats.filled, fixture.assignmentCount);
checkTrue('每个格子最多一位医生', stats.filled === stats.doctors.reduce((a, b) => a + b.total, 0));

console.log('== 4. 生成导出行 ==');
const exportOpts = {
  orgName: schedule.settings.orgName,
  deptName: schedule.settings.deptName,
  triageDesk: schedule.settings.triageDesk,
};
const built = exporter.buildRows(applied.roster, schedule, parsed.ym, exportOpts);
console.log(`  导出行数=${built.rows.length}`);
console.log('  前 4 行：');
built.rows.slice(0, 4).forEach((r) => console.log('   ', JSON.stringify(r.cells)));
console.log('  最后 2 行：');
built.rows.slice(-2).forEach((r) => console.log('   ', JSON.stringify(r.cells)));
check('导出行数 = 已排格数', built.rows.length, fixture.assignmentCount);
check('第一行日期', built.rows[0].cells[0], `${fixture.ym}-01`);
check('第一行班次', built.rows[0].cells[1], '上午');
check('第一行开始时间', built.rows[0].cells[2], `${fixture.ym}-01 08:00:00`);
check('科室名', built.rows[0].cells[5], fixture.department);
check('业务科室名称留空（科室设置里没填）', built.rows[0].cells[6], '');
check('分诊台名', built.rows[0].cells[10], '示例分诊台');
check('机构名称留空', built.rows[0].cells[4], '');
checkTrue('日期是升序的', built.rows.every((r, i, arr) => i === 0 || arr[i - 1].date <= r.date));

console.log('== 5. 写出 xlsx ==');
const result = exporter.exportWorkbook(applied.roster, schedule, parsed.ym, Object.assign({ outDir: OUT_DIR }, exportOpts));
console.log(`  已写出：${result.file}（${result.rowCount} 行，覆盖 ${result.dayCount} 天，用模板=${result.templateUsed}）`);
checkTrue('导出文件存在', fs.existsSync(result.file));
check('写出器', result.writer, 'openpyxl');

console.log('== 6. 复核导出的 xlsx ==');
const XLSX = require('xlsx');
const back = XLSX.readFile(result.file);
console.log('  sheet：', back.SheetNames);
const backWs = back.Sheets[back.SheetNames[0]];
const aoa = XLSX.utils.sheet_to_json(backWs, { header: 1, raw: false, defval: '' });
console.log('  表头：', JSON.stringify(aoa[0]));
check('表头列数', aoa[0].length, 14);
check(
  '表头 14 列与新模板一致',
  aoa[0].join('|'),
  '号源日期|班次|班次开始时间|班次结束时间|机构名称|坐诊科室名称|业务科室名称|坐诊医生编码|号别名称|诊室名称|分诊台名称|每个时间间隔号数|时间间隔（分钟）|现场号数'
);
check('数据行数', aoa.length - 1, result.rowCount);
console.log('  第 2 行：', JSON.stringify(aoa[1]));
checkTrue('日期是文本而非序列号', /^\d{4}-\d{2}-\d{2}$/.test(aoa[1][0]), aoa[1][0]);
check('开始时间是文本', aoa[1][2], `${aoa[1][0]} 08:00:00`);
checkTrue('日期全部是 YYYY-MM-DD 文本', aoa.slice(1).every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r[0])));
checkTrue('诊室名都在诊室设置里', aoa.slice(1).every((r) => schedule.rooms.some((x) => x.name === r[9])));
checkTrue('导出的格子数 = 已排数', aoa.length - 1 === fixture.assignmentCount);
// 各项默认值：号数 1 / 间隔 8 / 现场号数 0，且必须是文本
checkTrue(
  '每行都写了「每个时间间隔号数」',
  aoa.slice(1).every((r) => r[11] === String(store.DEFAULT_PER_INTERVAL)),
  aoa[1] && aoa[1][11]
);
checkTrue(
  '每行都写了「时间间隔（分钟）」',
  aoa.slice(1).every((r) => r[12] === String(store.DEFAULT_INTERVAL_MINUTES)),
  aoa[1] && aoa[1][12]
);
checkTrue('每行都写了「现场号数」0', aoa.slice(1).every((r) => r[13] === '0'), aoa[1] && aoa[1][13]);
// 业务科室名称：科室设置里填了才写，没填就是空
check(
  '业务科室名称取自科室设置',
  aoa[1][6],
  schedule.settings.businessDeptName || ''
);
// 号别名称：样例数据里的「医师」应被规范成「住院医师」
{
  const titles = new Set(aoa.slice(1).map((r) => r[8]));
  checkTrue('号别名称里没有旧叫法「医师」', !titles.has('医师'), [...titles].join('/'));
  checkTrue('号别名称已规范成「住院医师」', titles.has('住院医师'), [...titles].join('/'));
}
// 默认文件名：坐诊科室名称-年月（试算模式才返回；正式导出用同一个生成函数）
check(
  '默认文件名是「坐诊科室名称-年月」',
  exporter.defaultExportName(schedule, fixture.ym),
  `${schedule.settings.deptName}-${fixture.ym}`
);
check(
  '科室名称为空时退回「排班表-年月」',
  exporter.defaultExportName({ settings: { deptName: '' } }, fixture.ym),
  `排班表-${fixture.ym}`
);
check(
  '科室名称里的逗号会换成下划线（文件名不能带）',
  exporter.defaultExportName({ settings: { deptName: '内科门诊,呼吸门诊' } }, fixture.ym),
  `内科门诊_呼吸门诊-${fixture.ym}`
);

console.log('== 7. 样式保真（和模板逐格对比） ==');
const { spawnSync } = require('child_process');
const py = exporter.findPython();
if (py) {
  const pyCheck = `
# -*- coding: utf-8 -*-
import json, sys
from openpyxl import load_workbook
tpl = load_workbook(sys.argv[1])["号源排班"]
out = load_workbook(sys.argv[2])["号源排班"]
def sig(c):
    return [bool(c.font.b), c.font.sz, c.font.name, c.alignment.horizontal, c.alignment.vertical,
            c.number_format, c.border.left.style, c.border.bottom.style]
res = {}
for a, b in [("A1","A1"),("H1","H1"),("B2","B2"),("I2","I2")]:
    res[a] = {"tpl": sig(tpl[a]), "out": sig(out[b]), "same": sig(tpl[a]) == sig(out[b])}
res["widthA"] = {"tpl": tpl.column_dimensions["A"].width, "out": out.column_dimensions["A"].width}
res["A2type"] = type(out["A2"].value).__name__
res["C2type"] = type(out["C2"].value).__name__
print(json.dumps(res, ensure_ascii=False))
`;
  const pyFile = path.join(require('os').tmpdir(), 'derm-style-check.py');
  fs.writeFileSync(pyFile, pyCheck, 'utf8');
  const run = spawnSync(py, [pyFile, exporter.TEMPLATE_FILE, result.file], { encoding: 'utf8' });
  if (run.status !== 0) {
    failures += 1;
    console.log('FAIL  样式检查脚本报错：', (run.stderr || '').trim());
  } else {
    const style = JSON.parse(run.stdout.trim().split('\n').pop());
    for (const cell of ['A1', 'H1', 'B2', 'I2']) {
      checkTrue(`单元格 ${cell} 样式与模板一致`, style[cell].same, style[cell].same ? '' : `模板=${JSON.stringify(style[cell].tpl)} 导出=${JSON.stringify(style[cell].out)}`);
    }
    checkTrue('A 列列宽保留', Math.abs(style.widthA.tpl - style.widthA.out) < 0.01, `${style.widthA.tpl} → ${style.widthA.out}`);
    check('日期以文本写入（str）', style.A2type, 'str');
    check('开始时间以文本写入（str）', style.C2type, 'str');
  }
} else {
  console.log('  跳过（本机没有带 openpyxl 的 Python）');
}

console.log('== 8. 时间字段的边界情况 ==');
const t = exporter.shiftTime({ shiftTimes: {} }, '2027-03-05', '下午', schedule.shifts);
check('缺 shiftTimes 时用默认时刻', `${t.start}|${t.end}`, '2027-03-05 14:30:00|2027-03-05 17:30:00');

console.log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
