'use strict';
/**
 * 纯业务逻辑（不依赖 Electron），方便直接用 Node 测试。
 * electron/api.js 负责把这些函数注册成 IPC。
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const paths = require('./paths');
const legacy = require('./import-legacy');
const exporter = require('./export');

/** 界面需要的整包状态 */
function snapshot() {
  const roster = store.loadDoctors();
  const schedule = store.loadSchedule();
  const where = paths.describe();
  return {
    doctors: roster.doctors,
    settings: schedule.settings,
    rooms: schedule.rooms.slice().sort((a, b) => (a.order || 0) - (b.order || 0)),
    shifts: schedule.shifts,
    months: Object.keys(schedule.months).sort(),
    filledMonths: Object.entries(schedule.months)
      .filter(([, m]) => Object.values(m.slots || {}).some(Boolean))
      .map(([ym]) => ym)
      .sort(),
    paths: {
      root: where.root,
      packaged: where.packaged,
      data: where.data,
      exportDir: where.exportDir,
      // 导出排班表默认放桌面
      desktop: where.desktop,
      template: where.template,
      templateExists: fs.existsSync(where.template),
    },
    exportColumns: store.EXPORT_COLUMNS,
  };
}

/** 取某个月的完整排班（含按诊室/日期补齐格子） */
function getMonth(ym) {
  const schedule = store.loadSchedule();
  const roster = store.loadDoctors();
  const { added } = store.reconcileMonth(schedule, ym);
  if (added > 0) store.saveSchedule(schedule);
  const month = schedule.months[ym];
  const { year, month: mon } = store.parseYm(ym);
  return {
    ym,
    year,
    month: mon,
    rooms: schedule.rooms.slice().sort((a, b) => (a.order || 0) - (b.order || 0)),
    shifts: schedule.shifts,
    slots: month.slots,
    shiftTimes: month.shiftTimes,
    // 格子级时间设置（优先级高于医生级周规律）
    slotRules: month.slotRules || {},
    // 每个格子实际用的起止时间（已把格子设置 + 医生级周规律算进去），界面用它显示自定义时间标记
    slotTimes: store.resolveMonthShiftTimes(roster, schedule, month),
    note: month.note || '',
    isSeed: !!month.isSeed,
    stats: store.computeStats(roster.doctors, month, schedule.rooms),
    days: store.monthDays(ym, month.startDate, month.endDate),
  };
}

/** 只提交变化过的格子，避免界面整表覆盖磁盘 */
function patchMonth(ym, changes) {
  const schedule = store.loadSchedule();
  const { month } = store.reconcileMonth(schedule, ym);
  const doctorIds = new Set(store.loadDoctors().doctors.map((d) => d.id));
  let applied = 0;
  const rejected = [];
  for (const ch of changes || []) {
    const { date, shift, roomId } = ch;
    const key = `${date}|${shift}|${roomId}`;
    if (!(key in month.slots)) {
      rejected.push(`${key} 不在本月排班范围内`);
      continue;
    }
    const docId = ch.doctorId || null;
    if (docId && !doctorIds.has(docId)) {
      rejected.push(`${docId} 不是有效医生`);
      continue;
    }
    if (month.slots[key] === docId) continue;
    month.slots[key] = docId;
    applied += 1;
  }
  if (changes && changes.length && changes[0] && changes[0].note !== undefined) {
    month.note = String(changes[0].note);
  }
  month.updatedAt = new Date().toISOString();
  store.saveSchedule(schedule);
  return { applied, rejected };
}

/** 给某个格子单独设一段出诊时间（优先级高于医生级规律和班次默认） */
function setSlotTime(ym, date, shift, roomId, times) {
  const schedule = store.loadSchedule();
  const { month } = store.reconcileMonth(schedule, ym);
  const key = `${date}|${shift}|${roomId}`;
  if (!(key in month.slots)) throw new Error('这一格不在本月排班范围内');
  const rule = store.normalizeSlotRule(times || {});
  if (!month.slotRules) month.slotRules = {};
  if (rule) month.slotRules[key] = rule;
  else delete month.slotRules[key];
  month.updatedAt = new Date().toISOString();
  store.saveSchedule(schedule);
  return { key, rule };
}

/** 取消某个格子的时间设置，回到医生规律/班次默认 */
function clearSlotTime(ym, date, shift, roomId) {
  return setSlotTime(ym, date, shift, roomId, {});
}

function saveDoctors(doctors) {
  return store.saveDoctors({ doctors }).doctors;
}

function saveRooms(rooms) {
  const schedule = store.loadSchedule();
  const clean = (rooms || []).map((r, i) => ({
    id: r.id || store.newId('room'),
    name: String(r.name || '').trim(),
    short: String(r.short || '').trim() || store.shortName(r.name),
    order: Number(r.order) || i + 1,
  }));
  const seen = new Set();
  for (const r of clean) {
    if (!r.name) throw new Error('诊室名称不能为空');
    if (seen.has(r.name)) throw new Error(`诊室名称重复：${r.name}`);
    seen.add(r.name);
  }
  schedule.rooms = clean;
  for (const ym of Object.keys(schedule.months)) store.reconcileMonth(schedule, ym);
  store.saveSchedule(schedule);
  return clean;
}

function saveSettings(settings) {
  const schedule = store.loadSchedule();
  const next = Object.assign({}, schedule.settings, settings || {});
  delete next.shifts;
  // 现场号数：非负整数，留空/非法按 0
  const onsite = Number(next.onsiteCount);
  next.onsiteCount = Number.isFinite(onsite) && onsite >= 0 ? onsite : 0;
  next.businessDeptName = String(next.businessDeptName || '').trim();
  schedule.settings = next;
  if (settings && Array.isArray(settings.shifts) && settings.shifts.length) {
    schedule.shifts = settings.shifts.map((s) =>
      store.normalizeShift({
        name: s.name,
        start: String(s.start || '').trim(),
        end: String(s.end || '').trim(),
        perInterval: s.perInterval,
        interval: s.interval,
      })
    );
  }
  for (const ym of Object.keys(schedule.months)) store.reconcileMonth(schedule, ym);
  store.saveSchedule(schedule);
  return { settings: schedule.settings, shifts: schedule.shifts };
}

/** 调整某个月的日期范围（例如只排 1 号到 20 号） */
function setMonthRange(ym, startDate, endDate) {
  const schedule = store.loadSchedule();
  const { month } = store.reconcileMonth(schedule, ym);
  if (startDate) month.startDate = startDate;
  if (endDate) month.endDate = endDate;
  const result = store.reconcileMonth(schedule, ym);
  store.saveSchedule(schedule);
  return { added: result.added, startDate: month.startDate, endDate: month.endDate };
}

function createMonth(ym) {
  const schedule = store.loadSchedule();
  if (schedule.months[ym]) return { created: false, ym };
  const { added } = store.reconcileMonth(schedule, ym);
  store.saveSchedule(schedule);
  return { created: true, ym, added };
}

function clearMonth(ym, scope) {
  const schedule = store.loadSchedule();
  const { month } = store.reconcileMonth(schedule, ym);
  let cleared = 0;
  for (const key of Object.keys(month.slots)) {
    if (scope && scope.date && !key.startsWith(`${scope.date}|`)) continue;
    if (scope && scope.shift && key.split('|')[1] !== scope.shift) continue;
    if (scope && scope.roomId && key.split('|')[2] !== scope.roomId) continue;
    if (month.slots[key]) {
      month.slots[key] = null;
      cleared += 1;
    }
  }
  store.saveSchedule(schedule);
  return { cleared };
}

function deleteMonth(ym) {
  const schedule = store.loadSchedule();
  const existed = !!schedule.months[ym];
  delete schedule.months[ym];
  store.saveSchedule(schedule);
  return { deleted: existed };
}

/* ---------------- 导入 / 导出 ---------------- */

function previewLegacy(file) {
  return legacy.importLegacyWorkbook(file);
}

function applyLegacy(file) {
  const parsed = legacy.importLegacyWorkbook(file);
  const roster = store.loadDoctors();
  const schedule = store.loadSchedule();
  const applied = legacy.applyLegacyDoctors(roster, schedule.rooms, parsed);
  store.saveDoctors(applied.roster);
  const monthResult = legacy.applyLegacyMonth(schedule, applied.roster, parsed, applied.col2room);
  store.saveSchedule(schedule);
  return {
    ym: parsed.ym,
    importedSlots: Object.keys(parsed.assignments).length,
    filled: Object.values(monthResult.month.slots).filter(Boolean).length,
    addedDoctors: applied.added,
    rooms: schedule.rooms.length,
    warnings: parsed.warnings,
    anomalies: parsed.anomalies,
    skipped: monthResult.skipped,
  };
}

function exportMonth(ym, options) {
  const roster = store.loadDoctors();
  const schedule = store.loadSchedule();
  const opts = Object.assign({}, schedule.settings, options || {});
  if (opts.outFile) {
    // 界面把文件夹和文件名拼成完整路径传过来；路径可能已存在（用户自己选的，允许覆盖）
    opts.outDir = path.dirname(opts.outFile);
    if (!/\.xlsx$/i.test(opts.outFile)) opts.outFile += '.xlsx';
  }
  return exporter.exportWorkbook(roster, schedule, ym, opts);
}

module.exports = {
  snapshot,
  getMonth,
  patchMonth,
  setSlotTime,
  clearSlotTime,
  saveDoctors,
  saveRooms,
  saveSettings,
  setMonthRange,
  createMonth,
  clearMonth,
  deleteMonth,
  previewLegacy,
  applyLegacy,
  exportMonth,
};
