'use strict';
/** 诊室设置 + 科室设置 */

const RoomsView = {
  draft: null,

  render() {
    const tbody = clear($('#roomTbody'));
    if (!this.draft) this.draft = deepClone(App.rooms);
    this.draft.sort((a, b) => (a.order || 0) - (b.order || 0));
    $('#roomEmpty').hidden = this.draft.length > 0;

    this.draft.forEach((room, index) => {
      const tr = el('tr', { dataset: { index } });

      tr.appendChild(
        el('td', null, [
          el('button', { class: 'btn btn-sm btn-ghost', text: '↑', title: '上移', onclick: () => this.move(index, -1) }),
          el('button', { class: 'btn btn-sm btn-ghost', text: '↓', title: '下移', onclick: () => this.move(index, 1) }),
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
      const resident = this.findResident(room.name);
      for (const d of App.activeDoctors()) {
        doctorSelect.appendChild(el('option', { value: d.id, text: d.name }));
      }
      doctorSelect.value = resident ? resident.id : '';
      tr.appendChild(el('td', null, [doctorSelect]));

      tr.appendChild(
        el('td', null, [
          el('button', { class: 'btn btn-sm btn-danger', text: '删除', onclick: () => this.remove(index) }),
        ])
      );
      tbody.appendChild(tr);
    });

    for (const input of $$('#roomTbody [data-field]')) {
      const commit = () => {
        const tr = input.closest('tr');
        const room = this.draft[Number(tr.dataset.index)];
        if (!room) return;
        if (input.dataset.field === 'doctor') {
          const doc = App.doctor(input.value);
          if (doc) doc.room = room.name;
        } else {
          room[input.dataset.field] = input.value;
        }
      };
      input.oninput = commit;
      input.onchange = commit;
    }
  },

  findResident(roomName) {
    return App.activeDoctors().find((d) => d.room === roomName) || null;
  },

  move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= this.draft.length) return;
    const [item] = this.draft.splice(index, 1);
    this.draft.splice(target, 0, item);
    this.draft.forEach((r, i) => {
      r.order = i + 1;
    });
    this.render();
  },

  add() {
    if (!this.draft) this.draft = deepClone(App.rooms);
    const nextNo = this.draft.length + 1;
    this.draft.push({
      id: `room_new_${Date.now().toString(36)}`,
      name: `门诊诊室${nextNo}`,
      short: `诊室${nextNo}`,
      order: nextNo,
    });
    this.render();
  },

  remove(index) {
    const room = this.draft[index];
    if (!room) return;
    const used = App.month
      ? Object.entries(App.month.slots).filter(([k, v]) => k.endsWith(`|${room.id}`) && v).length
      : 0;
    const message = used
      ? `「${room.name}」本月有 ${used} 个已排班次。删除这一列后这些班次会一起消失，确定删除吗？`
      : `确定删除诊室「${room.name}」吗？`;
    if (!window.confirm(message)) return;
    this.draft.splice(index, 1);
    this.draft.forEach((r, i) => {
      r.order = i + 1;
    });
    this.render();
  },

  async save() {
    if (!this.draft) return;
    const empty = this.draft.find((r) => !String(r.name || '').trim());
    if (empty) {
      toast('有诊室没填名称', 'err');
      return;
    }
    try {
      const saved = await call(window.api.rooms.save, this.draft);
      App.snapshot.rooms = saved;
      this.draft = null;
      // 诊室变了，医生默认诊室可能也跟着变，重新拉一遍
      await App.load();
      await App.loadMonth(App.ym);
      this.render();
      SettingsView.render();
      ScheduleView.render();
      toast('诊室设置已保存', 'ok');
    } catch (err) {
      toast(`保存失败：${err.message}`, 'err');
    }
  },
};

const SettingsView = {
  render() {
    const s = App.snapshot.settings || {};
    $('#setOrgName').value = s.orgName || '';
    $('#setDeptName').value = s.deptName || '';
    $('#setTriageDesk').value = s.triageDesk || '';

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
      tbody.appendChild(tr);
    }
  },

  async save() {
    const shifts = [];
    for (const tr of $$('#shiftTbody tr')) {
      const get = (f) => tr.querySelector(`[data-field="${f}"]`).value.trim();
      const name = get('name');
      if (!name) {
        toast('班次名称不能为空', 'err');
        return;
      }
      if (!/^\d{2}:\d{2}(:\d{2})?$/.test(get('start')) || !/^\d{2}:\d{2}(:\d{2})?$/.test(get('end'))) {
        toast(`「${name}」的时间格式要像 08:00:00`, 'err');
        return;
      }
      const norm = (t) => (t.length === 5 ? `${t}:00` : t);
      shifts.push({ name, start: norm(get('start')), end: norm(get('end')) });
    }
    try {
      const res = await call(window.api.settings.save, {
        orgName: $('#setOrgName').value.trim(),
        deptName: $('#setDeptName').value.trim(),
        triageDesk: $('#setTriageDesk').value.trim(),
        shifts,
      });
      App.snapshot.settings = res.settings;
      App.snapshot.shifts = res.shifts;
      await App.loadMonth(App.ym);
      this.render();
      ScheduleView.render();
      toast('设置已保存', 'ok');
    } catch (err) {
      toast(`保存失败：${err.message}`, 'err');
    }
  },
};

document.addEventListener('DOMContentLoaded', () => {
  $('#btnAddRoom').onclick = () => RoomsView.add();
  $('#btnSaveRooms').onclick = () => RoomsView.save();
  $('#btnSaveSettings').onclick = () => SettingsView.save();
});
