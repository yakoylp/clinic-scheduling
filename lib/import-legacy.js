'use strict';
/**
 * 从旧排班表（横向网格版）导入一个月的排班。
 *
 * 旧表 Sheet1 结构：
 *   A 列日期（可能是 Excel 序列号，也可能是「2日」这种文本）
 *   B 列星期（合并两行）
 *   C 列上午/下午（每天两行）
 *   D 列起为各诊室，第 3 行是诊室名，第 3 行下面（D3:I3）是诊室对应的医生
 *   每个格子里填医生姓名
 */
const XLSX = require('xlsx');
const store = require('./store');

const WEEK_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/**
 * Excel 序列号 → JS Date（Excel 的 1900 历法）。
 * 注意：25569 这个基准算出来的是「本地时间的当天 00:00」，取值必须用本地 get*，
 * 用 getUTC* 在东八区会整体退一天。
 */
function serialToDate(serial) {
  return new Date(Math.round((serial - 25569) * 86400 * 1000));
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function cellText(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/** 兼容各种日期写法：46296 / '2026-10-01' / '1日' / '2026/10/1' / Date 对象 */
function parseDayCell(value, year, month) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return { iso: fmtDate(value), day: value.getDate() };
  const text = cellText(value);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (m) {
    const dd = Number(m[3]);
    return { iso: `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(dd).padStart(2, '0')}`, day: dd };
  }
  m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})/.exec(text);
  if (m) {
    const dd = Number(m[3]);
    return { iso: `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(dd).padStart(2, '0')}`, day: dd };
  }
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/.exec(text);
  if (m) {
    // M/D/YY（Excel 默认短日期显示）
    let yy = Number(m[3]);
    if (yy < 100) yy += 2000;
    const mo = Number(m[1]);
    const dd = Number(m[2]);
    return { iso: `${yy}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}`, day: dd };
  }
  m = /(\d{1,2})\s*日/.exec(text);
  if (m && year && month) {
    const dd = Number(m[1]);
    return { iso: `${year}-${String(month).padStart(2, '0')}-${String(dd).padStart(2, '0')}`, day: dd };
  }
  if (/^\d+(\.\d+)?$/.test(text)) {
    const num = Number(text);
    if (num > 20000 && num < 80000) {
      const d = serialToDate(num);
      return { iso: fmtDate(d), day: d.getDate() };
    }
    const dd = Math.round(num);
    if (dd >= 1 && dd <= 31 && year && month) {
      return { iso: `${year}-${String(month).padStart(2, '0')}-${String(dd).padStart(2, '0')}`, day: dd };
    }
  }
  return null;
}

/** 从「月份：2027年3月份」这类文本里取年月 */
function parseYearMonth(text) {
  const m = /(\d{4})\s*年\s*(\d{1,2})\s*月/.exec(cellText(text));
  if (m) return { year: Number(m[1]), month: Number(m[2]) };
  return null;
}

/**
 * 主入口。
 * @returns {{ ym, year, month, days, assignments, doctors, rooms, warnings, source }}
 */
function importLegacyWorkbook(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const sheetName = wb.SheetNames.includes('Sheet1') ? 'Sheet1' : wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error('工作簿里没有可读的工作表');
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:I1');
  const warnings = [];

  const get = (r, c) => {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (!cell) return '';
    return cellText(cell.w != null ? cell.w : cell.v);
  };
  const getRaw = (r, c) => {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    return cell ? cell.v : null;
  };

  // 年月：优先 A1/A2 的「月份：xxxx年x月」
  let yearMonth = null;
  for (let r = 0; r <= Math.min(range.e.r, 6) && !yearMonth; r += 1) {
    for (let c = 0; c <= Math.min(range.e.c, 3) && !yearMonth; c += 1) {
      yearMonth = parseYearMonth(getRaw(r, c));
    }
  }

  // 找数据首行：A 列能解析出日期的第一行。它上面那行是诊室/医生列表头
  let dataStartRow = -1;
  for (let r = 0; r <= range.e.r; r += 1) {
    if (parseDayCell(getRaw(r, 0), yearMonth && yearMonth.year, yearMonth && yearMonth.month)) {
      dataStartRow = r;
      break;
    }
  }
  if (dataStartRow < 0) throw new Error('A 列里找不到日期，无法识别排班网格');
  const headerRow = dataStartRow - 1;

  // 诊室列：表头行 D 列起。注意旧表该行同时是「诊室名」也是「该诊室医生名」
  const roomCols = [];
  for (let c = 3; c <= range.e.c; c += 1) {
    const name = get(headerRow, c);
    if (name) roomCols.push({ col: c, name });
  }
  if (roomCols.length === 0) {
    for (let c = 3; c <= range.e.c; c += 1) {
      roomCols.push({ col: c, name: `诊室${c - 2}` });
    }
    warnings.push('没识别到诊室表头，已按 诊室1..N 顺序处理');
  }

  // 各列出现最多的医生姓名：旧表一个诊室固定一位医生，据此把诊室对齐到人
  const colTally = new Map(); // col -> Map(name -> count)
  for (const rc of roomCols) colTally.set(rc.col, new Map());
  for (let r = dataStartRow; r <= range.e.r; r += 1) {
    const shift = get(r, 2);
    if (shift !== '上午' && shift !== '下午') continue;
    for (const rc of roomCols) {
      const name = get(r, rc.col);
      if (!name || name.length > 12) continue;
      const tally = colTally.get(rc.col);
      tally.set(name, (tally.get(name) || 0) + 1);
    }
  }
  for (const rc of roomCols) {
    const tally = [...colTally.get(rc.col).entries()].sort((a, b) => b[1] - a[1]);
    rc.doctor = tally.length ? tally[0][0] : '';
    rc.doctorCount = tally.length ? tally[0][1] : 0;
    rc.doctorTotal = [...colTally.get(rc.col).values()].reduce((a, b) => a + b, 0);
  }

  // 逐行解析
  const assignments = {}; // 'YYYY-MM-DD|上午|诊室名' -> 医生姓名
  const foundNames = new Map(); // 姓名 -> 出现次数
  const anomalies = []; // 同一列里出现的其他医生（可能是跨诊室替班）
  const daySet = new Set();
  let lastDay = null;
  let rows = 0;

  for (let r = dataStartRow; r <= range.e.r; r += 1) {
    const rawDay = getRaw(r, 0);
    let day = parseDayCell(rawDay, yearMonth && yearMonth.year, yearMonth && yearMonth.month);
    if (day) {
      lastDay = day;
    } else {
      day = lastDay;
    }
    if (!day) continue;

    const shift = get(r, 2);
    if (shift !== '上午' && shift !== '下午') continue;
    rows += 1;
    daySet.add(day.iso);

    for (const rc of roomCols) {
      const name = get(r, rc.col);
      if (!name) continue;
      if (name.length > 12) {
        warnings.push(`${day.iso} ${shift} ${rc.name} 的单元格内容异常已跳过：${name}`);
        continue;
      }
      assignments[`${day.iso}|${shift}|${rc.name}`] = name;
      foundNames.set(name, (foundNames.get(name) || 0) + 1);
      if (rc.doctor && name !== rc.doctor) {
        anomalies.push(`${day.iso} ${shift}：${rc.name} 列写的是「${name}」，该诊室通常是「${rc.doctor}」`);
      }
    }
  }

  if (!yearMonth) {
    const first = [...daySet].sort()[0];
    if (first) {
      const [y, m] = first.split('-');
      yearMonth = { year: Number(y), month: Number(m) };
      warnings.push('表头没写月份，已按第一条排班日期推断月份');
    }
  }
  if (!yearMonth) throw new Error('无法确定月份，请检查表格 A1 是否写了「月份：xxxx年x月」');

  const doctorNames = [...foundNames.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => {
      const rc = roomCols.find((r) => r.doctor === name);
      return { name, room: rc ? rc.name : '', count };
    });
  // 表头上写着的所有医生名（含整列没排班、因此没进 foundNames 的那些）
  const headerDoctorNames = roomCols
    .map((rc) => rc.doctor)
    .filter((n, i, arr) => !!n && arr.indexOf(n) === i);
  return {
    ym: store.ymOf(yearMonth.year, yearMonth.month),
    year: yearMonth.year,
    month: yearMonth.month,
    sheetName,
    days: [...daySet].sort(),
    assignments,
    doctors: doctorNames,
    headerDoctorNames,
    anomalies,
    rooms: roomCols.map((rc, i) => ({
      name: rc.name,
      short: store.shortName(rc.name),
      order: i + 1,
      doctor: rc.doctor,
    })),
    rows,
    warnings,
    source: filePath,
  };
}

/**
 * 用导入结果更新医生字典与诊室设置。同名医生复用，缺失的自动补一条。
 * @param roster {{ doctors: [] }} 医生字典（会被就地修改）
 * @param roomList {Array} 诊室设置（会被就地修改）
 * @param parsed importLegacyWorkbook 的返回值
 * @returns {{ roster, rooms, added: string[] }}
 */
/** 判断一对诊室名是不是指同一个地方（全名相等，或互为简名） */
function sameRoom(a, b, shortName) {
  if (!a || !b) return false;
  if (a === b) return true;
  return shortName(a) === b || shortName(b) === a;
}

/**
 * 决定一个诊室列重建后叫什么名字。
 *
 * 旧表这一列的表头可能是「该诊室的固定医生名」（而不是诊室名），这种情况下列名不能直接当
 * 诊室名用：优先取医生资料里那间仍然存在的诊室；如果医生资料里的诊室已经被弄脏——被污染成
 * 某个医生的名字，或者那间诊室已经不在诊室表里——就按「诊室N」给一个中性名字（不带任何
 * 科室字样，用户可以在「诊室设置」里改成自己的叫法）。这样即使之前误导入过，再导一次也能自愈。
 *
 * @param index 列序号（从 0 起）
 */
function resolveRoomName(doctor, columnLabel, isDoctorLabel, roomList, shortName, index, allDoctorNames) {
  if (!isDoctorLabel) return columnLabel;
  const current = doctor ? doctor.room : '';
  const polluted = !!current && allDoctorNames && allDoctorNames.has(current);
  const exists = !!current && roomList.some(
    (r) => sameRoom(r.name, current, shortName) || sameRoom(r.short, current, shortName)
  );
  if (current && exists && !polluted) return current;
  return `诊室${index + 1}`;
}

/**
 * 用导入结果更新医生字典与诊室设置。同名医生复用，缺失的自动补一条。
 * @param roster {{ doctors: [] }} 医生字典（会被就地修改）
 * @param roomList {Array} 诊室设置（会被就地修改）
 * @param parsed importLegacyWorkbook 的返回值
 * @returns {{ roster, rooms, added, col2room }}
 */
function applyLegacyDoctors(roster, roomList, parsed) {
  const added = [];
  const byName = new Map(roster.doctors.map((d) => [d.name, d]));
  const shortName = store.shortName;

  // 先按列算出每列的诊室名
  const col2room = new Map();
  const finalRooms = [];
  const rosterNames = new Set(roster.doctors.map((d) => d.name));
  // 表头写的是不是人名：只要这一列的名字出现在整张表的医生名单里就算，
  // 哪怕这一列整列没排班（那样它不会出现在 foundNames 里，但也确实是个人名）
  const headerNames = new Set([...(parsed.headerDoctorNames || []), ...parsed.doctors.map((d) => d.name)]);
  let order = 1;
  parsed.rooms.forEach((pr, index) => {
    const doc = byName.get(pr.doctor) || null;
    const isDoctorLabel = !!pr.name && pr.name === pr.doctor && headerNames.has(pr.name);
    const roomName = resolveRoomName(
      doc,
      pr.name,
      isDoctorLabel,
      roomList,
      shortName,
      index,
      rosterNames
    );
    const reused = roomList.find((r) => r.name === roomName || sameRoom(r.name, roomName, shortName));
    if (!finalRooms.some((r) => r.name === roomName)) {
      finalRooms.push({
        id: reused ? reused.id : store.newId('room'),
        name: roomName,
        short: reused && reused.short ? reused.short : store.shortName(roomName),
        order: order++,
      });
    }
    col2room.set(pr.name, roomName);
  });
  roomList.length = 0;
  roomList.push(...finalRooms);

  // 医生：已有的复用，缺的补一条
  for (const item of parsed.doctors) {
    const hit = byName.get(item.name) || byName.get(item.name.replace(/医生$/, ''));
    const pr = parsed.rooms.find((r) => r.doctor === item.name);
    const target = pr ? col2room.get(pr.name) : '';
    if (hit) {
      if (target) hit.room = target;
      else if (!hit.room || !finalRooms.some((r) => sameRoom(r.name, hit.room, shortName))) {
        hit.room = finalRooms[0] ? finalRooms[0].name : '';
      }
      continue;
    }
    const doc = {
      id: store.newId('doc'),
      name: item.name,
      code: '',
      title: '',
      room: target || '',
      color: store.PALETTE[roster.doctors.length % store.PALETTE.length],
      note: '从旧排班表导入',
      archived: false,
    };
    roster.doctors.push(doc);
    byName.set(doc.name, doc);
    added.push(doc.name);
  }

  return { roster, rooms: roomList, added, col2room };
}

/**
 * 把导入的排班写进整月数据。
 */
function applyLegacyMonth(schedule, roster, parsed, col2room) {
  const map = col2room || new Map(parsed.rooms.map((r) => [r.name, r.name]));
  const roomsSorted = schedule.rooms.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const roomByName = new Map(roomsSorted.map((r) => [r.name, r]));
  const docByName = new Map(roster.doctors.map((d) => [d.name, d]));
  const month = store.buildEmptyMonth(parsed.ym, schedule.rooms, schedule.shifts, {
    startDate: `${parsed.ym}-01`,
    endDate: parsed.days.length ? parsed.days[parsed.days.length - 1] : undefined,
  });
  const skipped = [];
  for (const [key, name] of Object.entries(parsed.assignments)) {
    const [date, shift, colLabel] = key.split('|');
    const room = roomByName.get(map.get(colLabel) || colLabel);
    const doc = docByName.get(name);
    if (!room || !doc) {
      skipped.push(name);
      continue;
    }
    month.slots[`${date}|${shift}|${room.id}`] = doc.id;
  }
  month.importedFrom = parsed.source;
  month.importedAt = new Date().toISOString();
  month.isSeed = true;
  schedule.months[parsed.ym] = month;
  return { month, skipped };
}

module.exports = {
  importLegacyWorkbook,
  applyLegacyDoctors,
  applyLegacyMonth,
  resolveRoomName,
  sameRoom,
  parseDayCell,
  parseYearMonth,
  serialToDate,
};
