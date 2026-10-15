'use strict';
/**
 * 全局状态：医生字典、诊室、当前月份排班、撤销重做、落盘。
 * 所有对排班的修改都走 App.setSlot / App.applyChanges，这样撤销和保存才有统一入口。
 */

/** 单次最多记多少步撤销 */
const UNDO_LIMIT = 200;

const App = {
  ready: false,
  snapshot: null,
  ym: null,
  month: null,
  stats: null,
  brushId: null,
  mode: 'paint',
  selected: null, // { date, shift, roomId }
  dirty: false,
  saving: false,
  _pending: new Map(), // key -> { date, shift, roomId, doctorId }
  _undo: [],
  _redo: [],
  _listeners: new Set(),
  _saveTimer: null,
  _autoTimer: null,

  /* ---------------- 事件 ---------------- */
  on(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  },
  emit(evt) {
    for (const fn of this._listeners) fn(evt || {});
  },

  /* ---------------- 基础数据 ---------------- */
  async load() {
    this.snapshot = await call(window.api.snapshot);
    this.ready = true;
    this.emit({ type: 'snapshot' });
    return this.defaultMonth();
  },

  /**
   * 打开软件时该显示哪个月：
   * 1) 最近一个有排班的月份（用户最可能接着看它，和旧表「打开就是上次那份」的习惯一致）
   * 2) 当前自然月（已经建过的话）
   * 3) 最后建过的月份
   */
  defaultMonth() {
    const months = (this.snapshot && this.snapshot.months) || [];
    const filled = (this.snapshot && this.snapshot.filledMonths) || [];
    if (filled.length) return filled[filled.length - 1];
    const now = currentYm();
    if (months.includes(now)) return now;
    return months.length ? months[months.length - 1] : now;
  },

  doctor(id) {
    return (this.snapshot.doctors || []).find((d) => d.id === id) || null;
  },

  room(id) {
    return (this.snapshot.rooms || []).find((r) => r.id === id) || null;
  },

  activeDoctors() {
    return (this.snapshot.doctors || []).filter((d) => !d.archived);
  },

  slotKey(date, shift, roomId) {
    return `${date}|${shift}|${roomId}`;
  },

  slot(date, shift, roomId) {
    if (!this.month) return null;
    return this.month.slots[this.slotKey(date, shift, roomId)] || null;
  },

  /**
   * 某个格子实际用的起止时间。
   * 现场按「当前排班 + 格子级设置 + 医生级周规律」算，而不是读主进程给的快照——
   * 用户刚改完格子或规律，快照就已经过时了，时间标记会画错。
   * 优先级与 lib/store.js 的 resolveCellShiftTime 保持一致。
   * @param key '日期|班次|诊室id'
   * @returns {{ start, end, customized, source }}
   */
  slotTime(key) {
    if (typeof key !== 'string' || !key.includes('|')) return null;
    const [date, shift, roomId] = key.split('|');
    if (!this.month || !(key in this.month.slots)) return null;
    return this.shiftTimeFor(date, shift, roomId);
  },

  /** 格子级时间设置：'日期|班次|诊室id' -> { start, end } */
  slotRules() {
    return (this.month && this.month.slotRules) || {};
  },

  /** 某位医生在某天某班次的实际上班时间（和 lib/store.js 的 effectiveShiftTime 同一套规则） */
  shiftTimeFor(date, shiftName, roomId) {
    const conf = (this.snapshot.shifts || []).find((s) => s.name === shiftName) || {};
    const base = { start: conf.start || '', end: conf.end || '' };
    const key = this.slotKey(date, shiftName, roomId);

    // 1) 格子自己的设置优先
    const cellRule = this.slotRules()[key];
    if (cellRule && (cellRule.start || cellRule.end)) {
      return {
        start: cellRule.start || base.start,
        end: cellRule.end || base.end,
        customized: true,
        source: 'cell',
      };
    }

    // 2) 医生级周规律
    const docId = this.slot(date, shiftName, roomId);
    const doc = docId ? this.doctor(docId) : null;
    const [y, m, d] = String(date).split('-').map(Number);
    const wd = new Date(y, m - 1, d).getDay();
    for (const rule of (doc && doc.timeRules) || []) {
      if (!Array.isArray(rule.days) || !rule.days.includes(wd)) continue;
      const hit = rule.shifts && rule.shifts[shiftName];
      if (!hit) continue;
      return {
        start: hit.start || base.start,
        end: hit.end || base.end,
        customized: true,
        source: 'doctor',
      };
    }

    // 3) 班次默认
    return Object.assign(base, { customized: false, source: 'shift' });
  },

  /** 整月所有格子的实际时间，按 '日期|班次|诊室id' 索引 */
  allSlotTimes() {
    const out = {};
    if (!this.month) return out;
    for (const key of Object.keys(this.month.slots)) {
      out[key] = this.slotTime(key) || { start: '', end: '', customized: false };
    }
    return out;
  },

  /* ---------------- 月份 ---------------- */
  async loadMonth(ym) {
    if (ym) this.ym = ym;
    if (!this.ym) this.ym = currentYm();
    $('#gridLoading') && ($('#gridLoading').hidden = false);
    try {
      const data = await call(window.api.month.get, this.ym);
      this.month = data;
      this.stats = data.stats;
      this._pending.clear();
      this._undo.length = 0;
      this._redo.length = 0;
      this.selected = null;
      this.emit({ type: 'month' });
      return data;
    } finally {
      const loading = $('#gridLoading');
      if (loading) loading.hidden = true;
    }
  },

  get days() {
    return (this.month && this.month.days) || [];
  },

  get shifts() {
    return (this.snapshot && this.snapshot.shifts) || [];
  },

  get rooms() {
    return (this.snapshot && this.snapshot.rooms) || [];
  },

  /* ---------------- 修改 ---------------- */
  /**
   * changes: [{ date, shift, roomId, doctorId }]
   * @param options {{ record: boolean }} 是否记入撤销
   */
  applyChanges(changes, options) {
    const opts = options || {};
    if (!changes || !changes.length || !this.month) return;
    const effective = [];
    for (const ch of changes) {
      const key = this.slotKey(ch.date, ch.shift, ch.roomId);
      if (!(key in this.month.slots)) continue;
      const before = this.month.slots[key] || null;
      const after = ch.doctorId || null;
      if (before === after) continue;
      effective.push({ date: ch.date, shift: ch.shift, roomId: ch.roomId, doctorId: after, before });
    }
    if (!effective.length) return;

    for (const ch of effective) {
      this.month.slots[this.slotKey(ch.date, ch.shift, ch.roomId)] = ch.doctorId;
      this._pending.set(this.slotKey(ch.date, ch.shift, ch.roomId), {
        date: ch.date,
        shift: ch.shift,
        roomId: ch.roomId,
        doctorId: ch.doctorId,
      });
    }

    if (opts.record !== false) {
      this._undo.push(effective);
      if (this._undo.length > UNDO_LIMIT) this._undo.shift();
      this._redo.length = 0;
    }

    this.recalcStats();
    this.markDirty();
    this.emit({ type: 'slots', changes: effective });
  },

  recalcStats() {
    if (!this.month || !this.snapshot) return;
    const doctors = this.activeDoctors();
    const byDoctor = new Map();
    const byRoom = new Map();
    let filled = 0;
    let total = 0;
    for (const [key, docId] of Object.entries(this.month.slots)) {
      total += 1;
      const roomId = key.split('|')[2];
      if (!byRoom.has(roomId)) byRoom.set(roomId, { filled: 0, total: 0 });
      byRoom.get(roomId).total += 1;
      if (!docId) continue;
      filled += 1;
      byRoom.get(roomId).filled += 1;
      if (!byDoctor.has(docId)) byDoctor.set(docId, { am: 0, pm: 0, total: 0 });
      const s = byDoctor.get(docId);
      s.total += 1;
      if (key.split('|')[1] === '上午') s.am += 1;
      else s.pm += 1;
    }
    this.stats = {
      doctors: doctors
        .map((d) => {
          const s = byDoctor.get(d.id) || { am: 0, pm: 0, total: 0 };
          return { id: d.id, name: d.name, color: d.color, am: s.am, pm: s.pm, total: s.total };
        })
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh')),
      rooms: this.rooms
        .slice()
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map((r) => {
          const s = byRoom.get(r.id) || { filled: 0, total: 0 };
          return { id: r.id, name: r.name, short: r.short, filled: s.filled, total: s.total };
        }),
      filled,
      total,
      empty: total - filled,
    };
  },

  /* ---------------- 撤销 / 重做 ---------------- */
  undo() {
    const step = this._undo.pop();
    if (!step) return false;
    const inverse = step.map((ch) => ({
      date: ch.date,
      shift: ch.shift,
      roomId: ch.roomId,
      doctorId: ch.before,
    }));
    this.applyChanges(inverse, { record: false });
    this._redo.push(step);
    return true;
  },

  redo() {
    const step = this._redo.pop();
    if (!step) return false;
    this.applyChanges(
      step.map((ch) => ({ date: ch.date, shift: ch.shift, roomId: ch.roomId, doctorId: ch.doctorId })),
      { record: false }
    );
    this._undo.push(step);
    return true;
  },

  get canUndo() {
    return this._undo.length > 0;
  },
  get canRedo() {
    return this._redo.length > 0;
  },

  /* ---------------- 保存 ---------------- */
  markDirty() {
    if (!this.dirty) {
      this.dirty = true;
      window.api.setDirty(true);
      this.emit({ type: 'dirty' });
    }
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(true), 1200);
  },

  async saveNow(silent) {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (!this._pending.size || !this.ym) {
      if (!silent) toast('没有需要保存的改动', 'ok');
      return { applied: 0 };
    }
    const changes = Array.from(this._pending.values());
    this._pending.clear();
    this.saving = true;
    try {
      const res = await call(window.api.month.patch, this.ym, changes);
      this.dirty = false;
      window.api.setDirty(false);
      this.emit({ type: 'dirty' });
      if (res.rejected && res.rejected.length) {
        toast(`有 ${res.rejected.length} 处改动被拒绝：${res.rejected[0]}`, 'warn');
      } else if (!silent) {
        toast(`已保存 ${res.applied} 处改动`, 'ok');
      }
      return res;
    } catch (err) {
      // 保存失败就把改动放回队列，避免用户以为已经存好
      for (const ch of changes) this._pending.set(this.slotKey(ch.date, ch.shift, ch.roomId), ch);
      toast(`保存失败：${err.message}`, 'err');
      throw err;
    } finally {
      this.saving = false;
      this.emit({ type: 'saved' });
    }
  },

  startAutoSave() {
    if (this._autoTimer) clearInterval(this._autoTimer);
    this._autoTimer = setInterval(() => {
      if (this.dirty && this._pending.size) this.saveNow(true).catch(() => {});
    }, 20000);
  },

  /* ---------------- 画笔 ---------------- */
  setBrush(id) {
    this.brushId = this.brushId === id ? null : id;
    this.emit({ type: 'brush' });
  },
  setMode(mode) {
    this.mode = mode;
    this.emit({ type: 'mode' });
  },
  setSelected(sel) {
    this.selected = sel;
    this.emit({ type: 'selection' });
  },
};
