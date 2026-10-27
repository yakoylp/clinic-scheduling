'use strict';
/**
 * 诊室设置 + 科室设置。
 *
 * 两个页面都是「一改动就自动保存，并立刻用主进程回传的结果刷新界面」：
 * 输入框内容先落到本地数据，防抖后保存；保存成功再回读一次，保证界面显示的就是真实存盘结果。
 * 页面顶部有保存状态提示，避免用户不确定到底存没存上。
 */

const PRESET_ROOM_COLORS = [
  '#2563eb', '#db2777', '#16a34a', '#f59e0b', '#7c3aed', '#0891b2',
];

const RoomsView = {
  _timer: null,
  _saving: false,
  _pending: false,

  render() {
    const tbody = clear($('#roomTbody'));
    const rooms = App.rooms.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    $('#roomEmpty').hidden = rooms.length > 0;
    this._signature = rooms.map((r) => r.id).join(',');

    rooms.forEach((room, index) => {
      const tr = el('tr', { dataset: { id: room.id, index } });

      tr.appendChild(
        el('td', null, [
          el('button', { class: 'btn btn-sm btn-ghost', text: '↑', title: '上移', onclick: () => this.move(room.id, -1) }),
          el('button', { class: 'btn btn-sm btn-ghost', text: '↓', title: '下移', onclick: () => this.move(room.id, 1) }),
        ])
      );
      tr.appendChild(
        el('td', null, [
          el('input', { class: 'input', value: room.short || '', dataset: { field: 'short' }, placeholder: '如 诊室1' }),
        ])
      );
      tr.appendChild(
        el('td', null, [
          el('input', {
            class: 'input',
            value: room.name || '',
            dataset: { field: 'name' },
            placeholder: '如 门诊诊室1',
          }),
        ])
      );

      const doctorSelect = el('select', { class: 'input', dataset: { field: 'doctor' } });
      doctorSelect.appendChild(el('option', { value: '', text: '（不指定）' }));
      const resident = App.activeDoctors().find((d) => d.room === room.name);
      for (const d of App.activeDoctors()) {
        doctorSelect.appendChild(el('option', { value: d.id, text: d.name }));
      }
      doctorSelect.value = resident ? resident.id : '';
      tr.appendChild(el('td', null, [doctorSelect]));

      tr.appendChild(
        el('td', null, [
          el('button', { class: 'btn btn-sm btn-danger', text: '删除', onclick: () => this.remove(room.id) }),
        ])
      );
      tbody.appendChild(tr);
    });

    for (const input of $$('#roomTbody [data-field]')) {
      const commit = () => this.collect(input);
      input.oninput = commit;
      input.onchange = commit;
      input.onblur = () => this.save(true);
    }
  },

  /** 把界面上的值收进 App.snapshot.rooms，然后排一次自动保存 */
  collect(input) {
    const tr = input.closest('tr');
    const room = App.rooms.find((r) => r.id === tr.dataset.id);
    if (!room) return;
    if (input.dataset.field === 'doctor') {
      const doc = App.doctor(input.value);
      for (const d of App.activeDoctors()) {
        if (d.id === input.value) d.room = room.name;
        else if (doc && d.room === room.name && d.id !== doc.id && input.value) d.room = '';
      }
    } else if (room[input.dataset.field] !== input.value) {
      room[input.dataset.field] = input.value;
      // 简名/名称改了，排班表列头要跟着变
      if (input.dataset.field === 'short') ScheduleView.render();
    }
    this.hint('有改动，正在自动保存…');
    this.scheduleSave();
  },

  scheduleSave() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.save(true), 800);
  },

  hint(text) {
    const node = $('#roomSaveHint');
    if (node) node.textContent = text || '';
  },

  move(roomId, delta) {
    const sorted = App.rooms.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const index = sorted.findIndex((r) => r.id === roomId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= sorted.length) return;
    const [item] = sorted.splice(index, 1);
    sorted.splice(target, 0, item);
    sorted.forEach((r, i) => {
      r.order = i + 1;
    });
    this.render();
    this.hint('有改动，正在自动保存…');
    this.save(true);
  },

  add() {
    const nextNo = App.rooms.length + 1;
    const room = {
      id: `room_new_${Date.now().toString(36)}`,
      name: `门诊诊室${nextNo}`,
      short: `诊室${nextNo}`,
      order: nextNo,
    };
    App.rooms.push(room);
    this.render();
    const row = $(`#roomTbody tr[data-id="${room.id}"]`);
    if (row) {
      const nameInput = row.querySelector('[data-field="name"]');
      if (nameInput) {
        nameInput.focus();
        nameInput.select();
      }
    }
    this.hint('已新增，填完自动保存');
    this.save(true);
  },

  remove(roomId) {
    const room = App.rooms.find((r) => r.id === roomId);
    if (!room) return;
    const used = App.month
      ? Object.entries(App.month.slots).filter(([k, v]) => k.endsWith(`|${room.id}`) && v).length
      : 0;
    const message = used
      ? `「${room.name}」本月有 ${used} 个已排班次。删除这一列后这些班次会一起消失，确定删除吗？`
      : `确定删除诊室「${room.name}」吗？`;
    if (!window.confirm(message)) return;
    const index = App.rooms.findIndex((r) => r.id === roomId);
    App.rooms.splice(index, 1);
    App.rooms.forEach((r, i) => {
      r.order = i + 1;
    });
    // 诊室删掉后，原先指向它的医生默认诊室要清掉
    for (const d of App.snapshot.doctors) {
      if (d.room === room.name) d.room = '';
    }
    this.render();
    this.hint('已删除，正在保存…');
    this.save(false);
  },

  /**
   * 保存诊室设置。
   * 名字还没填完时不报错、不保存（自动保存中途容易碰上空名字），只提示等填完。
   * @param silent true 表示这是自动保存，成功不弹 toast
   */
  async save(silent) {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._saving) {
      this._pending = true;
      return;
    }
    const rooms = App.rooms.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const emptyName = rooms.find((r) => !String(r.name || '').trim());
    if (emptyName) {
      this.hint('有诊室还没填名称，填完就会自动保存');
      return;
    }
    const dup = new Set();
    for (const r of rooms) {
      if (dup.has(r.name)) {
        this.hint(`诊室名称重复：${r.name}`);
        return;
      }
      dup.add(r.name);
    }

    this._saving = true;
    const roomsBefore = rooms.map((r) => r.id).join(',');
    try {
      // 保存诊室的同时把医生的「默认诊室」改动一起落盘
      const [savedRooms] = await Promise.all([
        call(window.api.rooms.save, rooms),
        call(window.api.doctors.save, App.snapshot.doctors),
      ]);

      // 回读真实结果，界面显示的就一定是存盘后的数据
      await App.load();
      const roomsChanged = roomsBefore !== App.rooms.map((r) => r.id).join(',');
      await App.loadMonth(App.ym);
      this.render();
      SettingsView.render();
      if (roomsChanged) ScheduleView.render();
      else ScheduleView.renderGridNames();
      ScheduleView.renderPalette();
      ScheduleView.renderSide();
      this.hint('已自动保存');
      this._clearHintLater();
      if (!silent) toast('诊室设置已保存', 'ok');
      void savedRooms;
    } catch (err) {
      this.hint(`保存失败：${err.message}`);
      toast(`诊室设置保存失败：${err.message}`, 'err');
    } finally {
      this._saving = false;
      if (this._pending) {
        this._pending = false;
        this.scheduleSave();
      }
    }
  },

  _clearHintLater() {
    const self = this;
    setTimeout(() => {
      if ($('#roomSaveHint') && $('#roomSaveHint').textContent === '已自动保存') self.hint('');
    }, 2000);
  },

  /** 还有没落盘的改动就立刻存掉（切页前、导出前调用） */
  async flushPending() {
    if (!this._timer && !App.dirty) return;
    await this.save(true);
  },
};

const SettingsView = {
  _timer: null,
  _saving: false,

  render() {
    const s = App.snapshot.settings || {};
    const set = (id, value) => {
      const node = $(id);
      if (node && node.value !== value) node.value = value || '';
    };
    set('#setOrgName', s.orgName);
    set('#setDeptName', s.deptName);
    set('#setBusinessDeptName', s.businessDeptName);
    set('#setTriageDesk', s.triageDesk);
    set('#setOnsiteCount', s.onsiteCount === undefined || s.onsiteCount === null ? '' : String(s.onsiteCount));

    const tbody = clear($('#shiftTbody'));
    for (const shift of App.shifts) {
      const tr = el('tr', { dataset: { name: shift.name } });
      tr.appendChild(el('td', null, [el('input', { class: 'input', value: shift.name, dataset: { field: 'name' } })]));
      tr.appendChild(
        el('td', null, [el('input', { class: 'input', value: shift.start, dataset: { field: 'start' }, placeholder: '08:00:00' })])
      );
      tr.appendChild(
        el('td', null, [el('input', { class: 'input', value: shift.end, dataset: { field: 'end' }, placeholder: '12:00:00' })])
      );
      tr.appendChild(
        el('td', null, [
          el('input', {
            class: 'input',
            value: shift.perInterval === undefined || shift.perInterval === null ? '' : String(shift.perInterval),
            dataset: { field: 'perInterval' },
            placeholder: '如 1',
            title: '每个时间间隔放几个号 → 导出表「每个时间间隔号数」列',
          }),
        ])
      );
      tr.appendChild(
        el('td', null, [
          el('input', {
            class: 'input',
            value: shift.interval === undefined || shift.interval === null ? '' : String(shift.interval),
            dataset: { field: 'interval' },
            placeholder: '如 8',
            title: '每隔几分钟放一次号 → 导出表「时间间隔（分钟）」列',
          }),
        ])
      );
      tbody.appendChild(tr);
    }

    for (const input of $$('#shiftTbody [data-field]')) {
      input.oninput = () => {
        this.hint('有改动，正在自动保存…');
        this.scheduleSave();
      };
      input.onchange = input.oninput;
      input.onblur = () => this.save(true);
    }
    for (const id of ['#setOrgName', '#setDeptName', '#setBusinessDeptName', '#setTriageDesk', '#setOnsiteCount']) {
      const input = $(id);
      if (!input) continue;
      input.oninput = () => {
        this.hint('有改动，正在自动保存…');
        this.scheduleSave();
      };
      input.onblur = () => this.save(true);
    }
  },

  scheduleSave() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.save(true), 800);
  },

  hint(text) {
    const node = $('#settingsSaveHint');
    if (node) node.textContent = text || '';
  },

  /** 从界面收集设置；有问题返回 { error } */
  collect() {
    const shifts = [];
    for (const tr of $$('#shiftTbody tr')) {
      const get = (f) => tr.querySelector(`[data-field="${f}"]`).value.trim();
      const name = get('name');
      if (!name) return { error: '班次名称不能为空' };
      if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(get('start')) || !/^\d{1,2}:\d{2}(:\d{2})?$/.test(get('end'))) {
        return { error: `「${name}」的时间格式要像 08:00` };
      }
      const norm = (t) => (t.split(':').length === 2 ? `${t}:00` : t).padStart(8, '0');
      // 两个间隔参数：留空就用出厂默认；填了必须是正数
      const count = (field, label, fallback) => {
        const raw = get(field);
        if (!raw) return fallback;
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) {
          return { error: `「${name}」的${label}要填正数` };
        }
        return n;
      };
      const perInterval = count('perInterval', '每个时间间隔号数', null);
      if (perInterval && perInterval.error) return { error: perInterval.error };
      const interval = count('interval', '时间间隔（分钟）', null);
      if (interval && interval.error) return { error: interval.error };
      shifts.push({
        name,
        start: norm(get('start')),
        end: norm(get('end')),
        perInterval: perInterval === null ? undefined : perInterval,
        interval: interval === null ? undefined : interval,
      });
    }
    // 现场号数：整张表一个值，留空按 0
    const onsiteRaw = $('#setOnsiteCount').value.trim();
    let onsiteCount = 0;
    if (onsiteRaw) {
      const n = Number(onsiteRaw);
      if (!Number.isFinite(n) || n < 0) return { error: '现场号数要填 0 或正整数' };
      onsiteCount = n;
    }
    return {
      value: {
        orgName: $('#setOrgName').value.trim(),
        deptName: $('#setDeptName').value.trim(),
        businessDeptName: $('#setBusinessDeptName').value.trim(),
        triageDesk: $('#setTriageDesk').value.trim(),
        onsiteCount,
        shifts,
      },
    };
  },

  async save(silent) {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._saving) return;
    const collected = this.collect();
    if (collected.error) {
      this.hint(collected.error);
      return;
    }
    this._saving = true;
    try {
      await call(window.api.settings.save, collected.value);
      await App.load();
      // 班次时间变了，格子的实际时间要重算，所以重新拉一次本月
      await App.loadMonth(App.ym);
      this.render();
      ScheduleView.render();
      this.hint('已自动保存');
      setTimeout(() => {
        if ($('#settingsSaveHint') && $('#settingsSaveHint').textContent === '已自动保存') this.hint('');
      }, 2000);
      if (!silent) toast('设置已保存', 'ok');
    } catch (err) {
      this.hint(`保存失败：${err.message}`);
      toast(`设置保存失败：${err.message}`, 'err');
    } finally {
      this._saving = false;
    }
  },

  async flushPending() {
    if (!this._timer) return;
    await this.save(true);
  },
};

document.addEventListener('DOMContentLoaded', () => {
  $('#btnAddRoom').onclick = () => RoomsView.add();

  // 切页 / 导出前，把还没落盘的改动存掉
  document.addEventListener('mousedown', (event) => {
    const tab = event.target.closest('.tab');
    if (tab) {
      RoomsView.flushPending().catch(() => {});
      SettingsView.flushPending().catch(() => {});
    }
  });
});
