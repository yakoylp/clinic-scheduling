'use strict';
/**
 * 生成一份「旧式横向网格排班表」示例工作簿，供测试和示例使用。
 *
 * 仓库里不能放真实医院的排班表，所以这里按需现场造一份结构完全一样的样例：
 *   A 列日期（故意混用 Excel 序列号与「x日」文本，跟真实旧表一样）
 *   B 列星期（每天第一行写，合并单元格那种效果）
 *   C 列上午/下午（每天两行）
 *   D 列起是各诊室，第 2 行写科室列表头、第 3 行写该诊室常驻医生名
 *   格子里填医生姓名
 *
 * 人名、科室名、诊室名全部是虚构占位，不含任何真实信息。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** 默认的虚构数据 */
const SAMPLE = {
  year: 2027,
  month: 3,
  days: 28,
  department: '示例科室',
  rooms: ['诊室一', '诊室二', '诊室三', '诊室四'],
  doctors: ['示例医生A', '示例医生B', '示例医生C', '示例医生D'],
};

/**
 * 造一份样例工作簿并写到文件。
 * @returns {{ file, ym, year, month, department, rooms, doctors, shifts, assignmentCount, dateCount }}
 */
function buildSampleWorkbook(options) {
  const cfg = Object.assign({}, SAMPLE, options || {});
  const { year, month, days, department, rooms, doctors } = cfg;

  const rows = [];
  rows.push([`月份：${year}年${month}月份`]);
  rows.push(['填报人：', '', '', ...rooms]);
  rows.push(['时间', '', '', ...doctors]);

  let assignmentCount = 0;
  const shifts = [];
  for (let day = 1; day <= days; day += 1) {
    const wd = new Date(year, month - 1, day).getDay();
    for (const shift of ['上午', '下午']) {
      // 和真实旧表一样：有的日子用序列号、有的用「x日」文本
      const serial = Math.round(
        (new Date(year, month - 1, day) - new Date(1899, 11, 30)) / 86400000
      );
      const dateCell = day % 2 === 1 ? serial : `${day}日`;
      const row = [dateCell, shift === '上午' ? WEEK[wd] : '', shift];
      for (let c = 0; c < rooms.length; c += 1) {
        let value = '';
        // 最后一列整列空着、每组第三个格子空着，用来测「没排班不导出」
        if (c < rooms.length - 1 && (day + c) % 3 !== 0 && day % 7 !== 0) value = doctors[c];
        if (value) assignmentCount += 1;
        row.push(value);
      }
      rows.push(row);
      shifts.push({ date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, shift });
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

  const dir = path.join(os.tmpdir(), 'derm-schedule-sample');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `示例排班表-${year}-${String(month).padStart(2, '0')}.xlsx`);
  XLSX.writeFile(wb, file);

  return {
    file,
    ym: `${year}-${String(month).padStart(2, '0')}`,
    year,
    month,
    days,
    department,
    rooms: rooms.slice(),
    doctors: doctors.slice(),
    // 最后一列整列空着，导入时认不出常驻医生，所以真实能认出来的是前面几位
    expectedDoctors: doctors.length - 1,
    shifts,
    assignmentCount,
    dateCount: days,
  };
}

module.exports = { buildSampleWorkbook, SAMPLE, WEEK };
