'use strict';
/**
 * 数据层：医生字典 + 月度排班 + 诊室设置。
 * 全部以 JSON 形式存放在项目 data/ 目录，纯本地，不联网。
 */
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const DATA_DIR = paths.resolveDataDir();
const DOCTORS_FILE = path.join(DATA_DIR, 'doctors.json');
const SCHEDULE_FILE = path.join(DATA_DIR, 'schedule.json');

/** 导出的固定列顺序（与 门诊排班模板.xlsx 的 号源排班 sheet 完全一致） */
const EXPORT_COLUMNS = [
  '号源日期',
  '班次',
  '班次开始时间',
  '班次结束时间',
  '机构名称',
  '坐诊科室名称',
  '坐诊医生编码',
  '号别名称',
  '诊室名称',
  '分诊台名称',
];

const DEFAULT_SHIFTS = [
  { name: '上午', start: '08:00:00', end: '12:00:00' },
  { name: '下午', start: '14:30:00', end: '17:30:00' },
];

/** 出厂状态不预设任何诊室，由用户按自己科室在「诊室设置」里建 */
const PALETTE = [
  '#2563eb', '#db2777', '#16a34a', '#f59e0b', '#7c3aed',
  '#0891b2', '#dc2626', '#65a30d', '#c026d3', '#0d9488',
  '#ea580c', '#4f46e5', '#059669', '#b45309', '#9333ea',
  '#0284c7', '#e11d48', '#15803d', '#a16207', '#6d28d9',
];

const newId = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`读取 ${path.basename(file)} 失败：${err.message}`);
  }
}

/** 原子写：先写临时文件再替换，避免写一半断电把数据写坏 */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return value;
}

/**
 * 模板里固定不变的科室参数，可在软件「设置」页改。
 * 默认留空，这样换任何科室都能直接用，不会把别的科室的字样带进导出表。
 */
const DEFAULT_SETTINGS = {
  orgName: '',
  deptName: '',
  triageDesk: '',
  hospitalName: '',
};

/* ------------------------------------------------------------------ */
/* 医生字典                                                            */
/* ------------------------------------------------------------------ */

const DAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** 时间字符串校验：接受 8:30 / 08:30 / 08:30:00，统一成 HH:MM:SS */
function normalizeClock(value) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || '').trim());
  if (!m) return '';
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return '';
  return `${String(h).padStart(2, '0')}:${m[2]}:${m[3] || '00'}`;
}

/**
 * 医生级「出诊时间规律」：按星期几覆盖班次的起止时间。
 * 例：某位医生周一到周五上午 08:30 开始，周六日 08:00 开始，就是两条规则：
 *   [{ days: [1,2,3,4,5], shifts: { 上午: { start: '08:30:00' } } },
 *    { days: [0,6],       shifts: { 上午: { start: '08:00:00' } } }]
 * 命中顺序 = 数组顺序，取第一条匹配的；没命中的班次用「科室设置」里的默认时间。
 */
function normalizeTimeRules(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  for (const rule of list) {
    if (!rule || typeof rule !== 'object') continue;
    const days = [...new Set(
      (Array.isArray(rule.days) ? rule.days : [])
        .map((d) => Number(d))
        .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    )].sort((a, b) => a - b);
    if (!days.length) continue;
    const shifts = {};
    const rawShifts = rule.shifts && typeof rule.shifts === 'object' ? rule.shifts : {};
    for (const [shiftName, times] of Object.entries(rawShifts)) {
      if (!shiftName || !times) continue;
      const start = normalizeClock(times.start);
      const end = normalizeClock(times.end);
      if (!start && !end) continue;
      shifts[shiftName] = { start, end };
    }
    if (!Object.keys(shifts).length) continue;
    out.push({ days, shifts });
  }
  return out;
}

function normalizeDoctor(d, index, usedIds) {
  const out = {
    id: d.id && String(d.id).trim() ? String(d.id) : newId('doc'),
    name: String(d.name || '').trim(),
    code: String(d.code || '').trim(),
    title: String(d.title || '').trim(),
    room: String(d.room || '').trim(),
    color: /^#[0-9a-fA-F]{6}$/.test(d.color || '') ? d.color : PALETTE[index % PALETTE.length],
    note: String(d.note || ''),
    archived: !!d.archived,
    timeRules: normalizeTimeRules(d.timeRules),
  };
  if (usedIds.has(out.id)) out.id = newId('doc');
  usedIds.add(out.id);
  return out;
}

/**
 * 算出某位医生在某一天某个班次的实际上班时间。
 * @param doctor   医生对象（可为 null）
 * @param weekday  JS 的 0..6（周日=0）
 * @param shiftName 例如 '上午'
 * @param defaults 班次默认时间 { start, end }（来自「科室设置」）
 * @returns {{ start, end, customized: boolean }}
 */
function effectiveShiftTime(doctor, weekday, shiftName, defaults) {
  const base = {
    start: (defaults && defaults.start) || '',
    end: (defaults && defaults.end) || '',
  };
  const rules = doctor && Array.isArray(doctor.timeRules) ? doctor.timeRules : [];
  for (const rule of rules) {
    if (!rule.days.includes(weekday)) continue;
    const hit = rule.shifts && rule.shifts[shiftName];
    if (!hit) continue;
    return {
      start: hit.start || base.start,
      end: hit.end || base.end,
      customized: true,
    };
  }
  return Object.assign(base, { customized: false });
}

function loadDoctors() {
  const data = readJson(DOCTORS_FILE, null);
  if (!data) {
    // 首次运行：建一个空的医生字典，不预设任何医生
    const empty = { version: 1, doctors: [] };
    writeJson(DOCTORS_FILE, empty);
    return empty;
  }
  const usedIds = new Set();
  const list = Array.isArray(data.doctors) ? data.doctors : [];
  return {
    version: 1,
    doctors: list.map((d, i) => normalizeDoctor(d, i, usedIds)),
  };
}

function saveDoctors(data) {
  const usedIds = new Set();
  const list = Array.isArray(data && data.doctors) ? data.doctors : [];
  const clean = { version: 1, doctors: list.map((d, i) => normalizeDoctor(d, i, usedIds)) };
  return writeJson(DOCTORS_FILE, clean);
}

/* ------------------------------------------------------------------ */
/* 月度排班                                                            */
/* ------------------------------------------------------------------ */

function loadSchedule() {
  const data = readJson(SCHEDULE_FILE, null);
  if (data && typeof data === 'object') {
    if (!data.months || typeof data.months !== 'object') data.months = {};
    // 注意不要在这里补默认诊室：出厂状态就是「一个诊室都没有」，等用户自己建
    if (!Array.isArray(data.rooms)) data.rooms = [];
    if (!Array.isArray(data.shifts) || data.shifts.length === 0) data.shifts = DEFAULT_SHIFTS.slice();
    data.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
    return data;
  }
  return {
    version: 1,
    settings: Object.assign({}, DEFAULT_SETTINGS),
    rooms: [],
    shifts: DEFAULT_SHIFTS.slice(),
    months: {},
  };
}

function saveSchedule(data) {
  return writeJson(SCHEDULE_FILE, data);
}

/**
 * 把「班次默认时间」和「医生级时间规律」合起来，算出这个月每个格子实际用哪段时间。
 *
 * @param roster   { doctors: [...] } 或直接是医生数组
 * @param schedule 含 shifts / rooms / settings
 * @param month    该月数据（含 slots、slotRules、startDate、endDate）
 * @returns {{ '日期|班次|诊室id': {start:'HH:MM:SS', end:'HH:MM:SS', customized:boolean, source:'shift'|'doctor'|'cell'} }}
 *          customized=true 表示这个格子因为医生的周规律或格子自己的设置而和班次默认时间不同
 */
function resolveMonthShiftTimes(roster, schedule, month) {
  const doctorList = Array.isArray(roster) ? roster : roster && roster.doctors ? roster.doctors : [];
  const byId = new Map(doctorList.map((d) => [d.id, d]));
  const shiftList = (schedule && schedule.shifts) || DEFAULT_SHIFTS;
  const ym = month && month.ym ? month.ym : inferYm(month);
  const days = ym ? monthDays(ym, month.startDate, month.endDate) : [];
  const slotRules = (month && month.slotRules) || {};
  const out = {};
  for (const day of days) {
    for (const shift of shiftList) {
      for (const room of (schedule && schedule.rooms) || []) {
        const key = `${day.date}|${shift.name}|${room.id}`;
        const doc = byId.get(month.slots[key]);
        out[key] = resolveCellShiftTime({
          slotRule: slotRules[key],
          doctor: doc || null,
          weekday: day.weekday,
          shift,
        });
      }
    }
  }
  return out;
}

/**
 * 单个格子用哪段时间。优先级：格子自己的设置 > 医生级周规律 > 班次默认。
 * 导出和界面都走这里，保证两边算出来的完全一致。
 */
function resolveCellShiftTime(opts) {
  const { slotRule, doctor, weekday, shift } = opts || {};
  const base = {
    start: (shift && shift.start) || '',
    end: (shift && shift.end) || '',
  };
  if (slotRule && (slotRule.start || slotRule.end)) {
    return {
      start: slotRule.start || base.start,
      end: slotRule.end || base.end,
      customized: true,
      source: 'cell',
    };
  }
  const fromDoctor = effectiveShiftTime(doctor, weekday, shift && shift.name, base);
  return {
    start: fromDoctor.start,
    end: fromDoctor.end,
    customized: fromDoctor.customized,
    source: fromDoctor.customized ? 'doctor' : 'shift',
  };
}

/** 格子级时间设置的规范化：空值就是「没设置」 */
function normalizeSlotRule(input) {
  if (!input || typeof input !== 'object') return null;
  const start = normalizeClock(input.start);
  const end = normalizeClock(input.end);
  if (!start && !end) return null;
  return { start, end };
}

/** 该月所有格子级时间设置（只保留还有排班的格子，其余当作没设置） */
function normalizeSlotRules(input, slots) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (slots && !(key in slots)) continue;
    const rule = normalizeSlotRule(value);
    if (rule) out[key] = rule;
  }
  return out;
}


/** 月数据里没存 ym 时，从 startDate 推一下 */
function inferYm(month) {
  if (!month) return '';
  if (month.startDate) return String(month.startDate).slice(0, 7);
  if (month.endDate) return String(month.endDate).slice(0, 7);
  return '';
}

/**
 * 造 count 个通用诊室（诊室1、诊室2…）。
 * 注意：出厂数据里不调用它——真实使用要让用户在「诊室设置」里自己建。
 * 目前只有测试脚手架和导入旧表时的兜底命名会用到。
 */
function defaultRooms(count) {
  const total = Number(count) > 0 ? Number(count) : 5;
  const rooms = [];
  for (let i = 1; i <= total; i += 1) {
    rooms.push({ id: newId('room'), name: `诊室${i}`, short: `诊室${i}`, order: i });
  }
  return rooms;
}

/** 根据数据里出现过的诊室名推断诊室简名（门诊诊室1 → 诊室1） */
function shortName(fullName) {
  const m = /诊室\s*([0-9A-Za-z一二三四五六七八九十]+)\s*$/.exec(String(fullName || ''));
  return m ? `诊室${m[1]}` : String(fullName || '');
}

/** 取某个月的排班；没有就按当月天数建一个空的 */
function getMonth(data, ym, opts) {
  const options = opts || {};
  if (!data.months[ym]) {
    data.months[ym] = buildEmptyMonth(ym, data.rooms, data.shifts, options);
  }
  return data.months[ym];
}

function ymOf(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function parseYm(ym) {
  const m = /^(\d{4})-(\d{1,2})$/.exec(String(ym || ''));
  if (!m) throw new Error(`月份格式不对：${ym}`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function shiftDate(d) {
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + 1);
  return out;
}

/**
 * 生成整月日期清单：[{ date:'2026-10-01', day:1, weekday:4, weekdayName:'星期四', isWeekend:false }, ...]
 */
function monthDays(ym, startDate, endDate) {
  const { year, month } = parseYm(ym);
  const total = daysInMonth(year, month);
  const weekNames = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const out = [];
  for (let day = 1; day <= total; day += 1) {
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (startDate && iso < startDate) continue;
    if (endDate && iso > endDate) continue;
    const d = new Date(year, month - 1, day);
    const wd = d.getDay();
    out.push({
      date: iso,
      day,
      month,
      year,
      weekday: wd,
      weekdayName: weekNames[wd],
      isWeekend: wd === 0 || wd === 6,
    });
  }
  return out;
}

function buildEmptyMonth(ym, rooms, shifts, opts) {
  const options = opts || {};
  const { month } = parseYm(ym);
  const days = monthDays(ym, options.startDate, options.endDate);
  const roomsSorted = (rooms || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const slotList = [];
  for (const d of days) {
    for (const s of shifts || DEFAULT_SHIFTS) {
      for (const r of roomsSorted) {
        if (options.skipWeekends && d.isWeekend) continue;
        slotList.push(`${d.date}|${s.name}|${r.id}`);
      }
    }
  }
  return {
    ym,
    month,
    startDate: days.length ? days[0].date : null,
    endDate: days.length ? days[days.length - 1].date : null,
    slots: {},
    shiftTimes: buildShiftTimes(ym, days, shifts),
    note: '',
    isSeed: !!options.isSeed,
    _slotList: slotList,
  };
}

/** 每天每个班次的起止时间（与模板一致：日期 + 固定时刻） */
function buildShiftTimes(ym, days, shifts) {
  const out = {};
  for (const d of days) {
    for (const s of shifts || DEFAULT_SHIFTS) {
      out[`${d.date}|${s.name}`] = {
        start: `${d.date} ${s.start}`,
        end: `${d.date} ${s.end}`,
      };
    }
  }
  return out;
}

/**
 * 补齐：诊室、班次或日期范围变化后，让 month.slots / shiftTimes 覆盖到该有的格子。
 * 返回值：新补齐的格子数。已存在的排班不会被清除。
 */
function reconcileMonth(data, ym) {
  const month = getMonth(data, ym);
  const { year, month: mon } = parseYm(ym);
  const days = monthDays(ym, month.startDate, month.endDate);
  const roomsSorted = data.rooms.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const validRooms = new Set(roomsSorted.map((r) => r.id));
  const validKeys = new Set();
  let added = 0;
  for (const d of days) {
    for (const s of data.shifts) {
      for (const r of roomsSorted) {
        const key = `${d.date}|${s.name}|${r.id}`;
        validKeys.add(key);
        if (!(key in month.slots)) {
          month.slots[key] = null;
          added += 1;
        }
      }
    }
  }
  // 删掉已经不存在的诊室/日期的残留格子
  for (const key of Object.keys(month.slots)) {
    if (!validKeys.has(key)) delete month.slots[key];
  }
  // 格子级时间设置同样只保留有效格子，并规范化：手改数据写进非法时间（如 25:00）时挡掉，
  // 诊室删掉后残留的设置也一起清掉
  month.slotRules = normalizeSlotRules(month.slotRules, month.slots);
  month.shiftTimes = buildShiftTimes(ym, days, data.shifts);
  month.month = mon;
  month.year = year;
  month.updatedAt = new Date().toISOString();
  delete month._slotList;
  return { month, added };
}

/* ------------------------------------------------------------------ */
/* 统计                                                               */
/* ------------------------------------------------------------------ */

function computeStats(doctorList, month, roomList) {
  const byDoctor = {};
  const byRoom = {};
  let filled = 0;
  let total = 0;
  for (const [key, docId] of Object.entries(month.slots || {})) {
    total += 1;
    const roomId = key.split('|')[2];
    byRoom[roomId] = byRoom[roomId] || { filled: 0, total: 0 };
    byRoom[roomId].total += 1;
    if (!docId) continue;
    filled += 1;
    byRoom[roomId].filled += 1;
    byDoctor[docId] = byDoctor[docId] || { am: 0, pm: 0, total: 0 };
    byDoctor[docId].total += 1;
    if (key.split('|')[1] === '上午') byDoctor[docId].am += 1;
    else byDoctor[docId].pm += 1;
  }
  const doctors = doctorList
    .filter((d) => !d.archived)
    .map((d) => {
      const s = byDoctor[d.id] || { am: 0, pm: 0, total: 0 };
      return { id: d.id, name: d.name, color: d.color, am: s.am, pm: s.pm, total: s.total };
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh'));
  const rooms = roomList
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((r) => {
      const s = byRoom[r.id] || { filled: 0, total: 0 };
      return { id: r.id, name: r.name, short: r.short || shortName(r.name), filled: s.filled, total: s.total };
    });
  return { doctors, rooms, filled, total, empty: total - filled };
}

module.exports = {
  DATA_DIR,
  DOCTORS_FILE,
  SCHEDULE_FILE,
  EXPORT_COLUMNS,
  DEFAULT_SHIFTS,
  DEFAULT_SETTINGS,
  PALETTE,
  newId,
  readJson,
  writeJson,
  loadDoctors,
  saveDoctors,
  loadSchedule,
  saveSchedule,
  defaultRooms,
  shortName,
  normalizeClock,
  normalizeTimeRules,
  effectiveShiftTime,
  resolveMonthShiftTimes,
  resolveCellShiftTime,
  normalizeSlotRule,
  normalizeSlotRules,
  getMonth,
  reconcileMonth,
  ymOf,
  parseYm,
  daysInMonth,
  monthDays,
  buildEmptyMonth,
  buildShiftTimes,
  computeStats,
  shiftDate,
};
