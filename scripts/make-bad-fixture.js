'use strict';
/**
 * 造一份「有毛病」的示例排班表，用来测导入容错：整列没人、某天整天不排、
 * 有一格写了超长乱文本。数据全部虚构。
 * 用法：node scripts/make-bad-fixture.js [输出路径]
 */
require('./test-env');
const path = require('path');
const os = require('os');
const XLSX = require('xlsx');
const { WEEK } = require('../lib/legacy-sample');

const OUT = process.argv[2] || path.join(os.tmpdir(), 'derm-schedule-sample', '示例排班表-有毛病.xlsx');

const year = 2027;
const month = 4;
const days = 30;
const rooms = ['诊室一', '诊室二', '诊室三'];
const doctors = ['示例医生甲', '示例医生乙', '示例医生丙'];

const rows = [];
rows.push([`月份：${year}年${month}月份`]);
rows.push(['填报人：', '', '', ...rooms]);
rows.push(['时间', '', '', ...doctors]);

let emptyDay = 20;
for (let day = 1; day <= days; day += 1) {
  const wd = new Date(year, month - 1, day).getDay();
  for (const shift of ['上午', '下午']) {
    const serial = Math.round((new Date(year, month - 1, day) - new Date(1899, 11, 30)) / 86400000);
    const row = [day === 1 ? serial : `${day}日`, shift === '上午' ? WEEK[wd] : '', shift];
    for (let c = 0; c < rooms.length; c += 1) {
      let value = '';
      if (day !== emptyDay) {
        if (c === rooms.length - 1) value = ''; // 第三诊室整月没人
        else if ((day + c) % 3 !== 0) value = doctors[c];
      }
      row.push(value);
    }
    rows.push(row);
  }
}
// 一格明显不是姓名的超长文本
rows[12][3] = '这是一个明显不是姓名的超长文本内容，用来测试导入时的容错处理';

const ws = XLSX.utils.aoa_to_sheet(rows);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
const fs = require('fs');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
XLSX.writeFile(wb, OUT);
console.log(`坏表已生成：${OUT}`);
console.log(`  月份 ${year}-${String(month).padStart(2, '0')}，诊室 ${rooms.length} 个，医生 ${doctors.length} 位`);
console.log(`  其中：第三诊室整月空、${emptyDay} 日整天不排、有一格是超长乱文本`);
