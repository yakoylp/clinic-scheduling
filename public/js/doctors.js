'use strict';
/** 医生资料页：颜色折叠选择、改动自动保存 */

const DOCTOR_COLORS = [
  '#2563eb', '#db2777', '#16a34a', '#f59e0b', '#7c3aed',
  '#0891b2', '#dc2626', '#65a30d', '#c026d3', '#0d9488',
  '#ea580c', '#4f46e5', '#059669', '#b45309', '#9333ea',
  '#0284c7', '#e11d48', '#15803d', '#a16207', '#6d28d9',
];

const DoctorsView = {
  _timer: null,
  _popover: null,
  _saving: false,

  render() {
    this.closePopover();
    const tbody = clear($('#doctorTbody'));
    const doctors = App.snapshot.doctors || [];
    $('#doctorEmpty').hidden = doctors.length > 0;

    doctors.forEach((doc) => {
      const tr = el('tr', { dataset: { id: doc.id } });

      // 颜色：默认只显示一个小圆点，点开才出调色板
      const colorCell = el('td', { class: 'color-cell' });
      const trigger = el('button', {
        class: 'color-trigger',
        title: '点击选择颜色',
        style: `background:${doc.color || '#2563eb'}`,
      });
      trigger.onclick = (event) => {
        event.stopPropagation();
        this.openPopover(trigger, doc);
      };
      colorCell.appendChild(trigger);
      tr.appendChild(colorCell);

      tr.appendChild(
        el('td', null, [el('input', { class: 'input', value: doc.name, dataset: { field: 'name' }, placeholder: '姓名' })])
      );
      tr.appendChild(
        el('td', null, [el('input', { class: 'input', value: doc.code, dataset: { field: 'code' }, placeholder: '如 doctor001' })])
      );
      tr.appendChild(
        el('td', null, [
          el('input', {
            class: 'input',
            value: doc.title,
            dataset: { field: 'title' },
            placeholder: '如 医师 / 副主任医师',
            list: 'titleOptions',
          }),
        ])
      );

      const roomSelect = el('select', { class: 'input', dataset: { field: 'room' } });
      roomSelect.appendChild(el('option', { value: '', text: '（未设置）' }));
      for (const r of App.rooms) {
        roomSelect.appendChild(el('option', { value: r.name, text: r.short ? `${r.short} · ${r.name}` : r.name }));
      }
      if (doc.room && !App.rooms.some((r) => r.name === doc.room)) {
        roomSelect.appendChild(el('option', { value: doc.room, text: `${doc.room}（不在诊室设置里）` }));
      }
      roomSelect.value = doc.room || '';
      tr.appendChild(el('td', null, [roomSelect]));

      tr.appendChild(
        el('td', null, [el('input', { class: 'input', value: doc.note || '', dataset: { field: 'note' }, placeholder: '备注（可选）' })])
      );

      tr.appendChild(
        el('td', null, [
          el('button', { class: 'btn btn-sm btn-danger', text: '删除', onclick: () => this.remove(doc.id) }),
        ])
      );
      tbody.appendChild(tr);
    });

    for (const input of $$('#doctorTbody [data-field]')) {
      input.oninput = () => this.collectAndSchedule(input);
      input.onchange = () => this.collectAndSchedule(input);
      input.onblur = () => this.save(true);
    }
  },

  /** 把界面上的值收进内存，然后排一次自动保存 */
  collectAndSchedule(input) {
    const tr = input.closest('tr');
    const doc = App.snapshot.doctors.find((d) => d.id === tr.dataset.id);
    if (!doc) return;
    const field = input.dataset.field;
    if (doc[field] !== input.value) {
      doc[field] = input.value;
      // 姓名/诊室会显示在排班表和顶部选人条上，立刻同步
      if (field === 'name' || field === 'room') {
        ScheduleView.renderPalette();
        if (field === 'name') ScheduleView.renderGridNames();
      }
    }
    App.dirty = true;
    window.api.setDirty(true);
    this.hint('有改动，正在自动保存…');
    this.scheduleSave();
  },

  scheduleSave() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.save(true), 900);
  },

  hint(text) {
    const node = $('#doctorSaveHint');
    if (node) node.textContent = text || '';
  },

  /* ---------------- 颜色弹层 ---------------- */
  openPopover(anchor, doc) {
    this.closePopover();
    const pop = el('div', { class: 'color-popover' });
    for (const c of DOCTOR_COLORS) {
      const sw = el('button', {
        class: `swatch${doc.color === c ? ' active' : ''}`,
        style: `background:${c}`,
        title: c,
      });
      sw.onclick = () => {
        doc.color = c;
        anchor.style.background = c;
        this.closePopover();
        App.dirty = true;
        window.api.setDirty(true);
        ScheduleView.renderPalette();
        ScheduleView.renderGridNames();
        ScheduleView.renderSide();
        this.hint('有改动，正在自动保存…');
        this.scheduleSave();
      };
      pop.appendChild(sw);
    }
    document.body.appendChild(pop);
    const rect = anchor.getBoundingClientRect();
    pop.style.left = `${Math.min(rect.left - 8, window.innerWidth - pop.offsetWidth - 12)}px`;
    pop.style.top = `${rect.bottom + 6}px`;
    this._popover = pop;
    setTimeout(() => {
      const close = (event) => {
        if (!pop.contains(event.target) && event.target !== anchor) {
          this.closePopover();
          document.removeEventListener('mousedown', close);
        }
      };
      this._closeHandler = close;
      document.addEventListener('mousedown', close);
    }, 0);
  },

  closePopover() {
    if (this._closeHandler) {
      document.removeEventListener('mousedown', this._closeHandler);
      this._closeHandler = null;
    }
    if (this._popover) {
      this._popover.remove();
      this._popover = null;
    }
  },

  add() {
    App.snapshot.doctors.push({
      id: `doc_new_${Date.now().toString(36)}`,
      name: '',
      code: '',
      title: '',
      room: '',
      color: DOCTOR_COLORS[App.snapshot.doctors.length % DOCTOR_COLORS.length],
      note: '',
      archived: false,
    });
    App.dirty = true;
    window.api.setDirty(true);
    this.render();
    const rows = $$('#doctorTbody tr');
    const last = rows[rows.length - 1];
    if (last) {
      const nameInput = last.querySelector('[data-field="name"]');
      if (nameInput) nameInput.focus();
    }
    this.hint('已新增一行，填完会自动保存');
    this.scheduleSave();
  },

  async remove(id) {
    const index = App.snapshot.doctors.findIndex((d) => d.id === id);
    if (index < 0) return;
    const doc = App.snapshot.doctors[index];
    const used = App.month ? Object.values(App.month.slots).filter((v) => v === doc.id).length : 0;
    const message = used
      ? `「${doc.name}」本月已排了 ${used} 个班次。删除后这些格子会空出来，确定删除吗？`
      : `确定删除「${doc.name || '这位医生'}」吗？`;
    if (!window.confirm(message)) return;
    App.snapshot.doctors.splice(index, 1);
    App.dirty = true;
    window.api.setDirty(true);
    this.closePopover();
    await this.save(false);
  },

  /** 还有没落盘的改动就立刻存掉（导出前、切页前调用） */
  async flushPending() {
    if (!this._timer) return;
    await this.save(true);
  },

  /**
   * 保存医生字典。
   * 保存后不整页重绘（那会打断正在输入的人），只把主进程回传的规范化结果合并回来。
   */
  async save(silent) {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._saving) {
      this.scheduleSave();
      return;
    }
    this._saving = true;
    try {
      const saved = await call(window.api.doctors.save, App.snapshot.doctors);
      const byId = new Map(App.snapshot.doctors.map((d) => [d.id, d]));
      App.snapshot.doctors = saved.map((d) => {
        const local = byId.get(d.id);
        if (local) {
          Object.assign(local, d);
          return local;
        }
        return d;
      });
      App.dirty = false;
      window.api.setDirty(false);
      ScheduleView.renderPalette();
      ScheduleView.renderGridNames();
      ScheduleView.renderSide();
      this.hint('已自动保存');
      setTimeout(() => {
        if ($('#doctorSaveHint') && $('#doctorSaveHint').textContent === '已自动保存') this.hint('');
      }, 1800);
      // 新增的行需要拿到正式 id，重绘一次最省事（此时没有正在输入的内容）
      const drafting = App.snapshot.doctors.some((d) => String(d.id).startsWith('doc_new_'));
      if (drafting && !silent) this.render();
    } catch (err) {
      this.hint('保存失败：' + err.message);
      toast(`医生资料保存失败：${err.message}`, 'err');
    } finally {
      this._saving = false;
    }
  },
};

document.addEventListener('DOMContentLoaded', () => {
  $('#btnAddDoctor').onclick = () => DoctorsView.add();
  // 离开医生页时把还没落盘的改动存掉
  document.addEventListener('mousedown', (event) => {
    const tab = event.target.closest('.tab');
    if (tab && tab.dataset.tab !== 'doctors' && DoctorsView._timer) DoctorsView.save(true);
    if (!event.target.closest('.color-trigger') && !event.target.closest('.color-popover')) {
      DoctorsView.closePopover();
    }
  });
});
