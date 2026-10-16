'use strict';
/**
 * 排班表渲染与交互：网格、画笔、拖拽排班、右键菜单、侧栏统计。
 */

const ScheduleView = {
  _drag: null,
  _sideTimer: null,
  _onScroll: null,

  render() {
    const scroll = $('#gridScroll');
    const head = $('#gridHead');
    if (!App.month) {
      clear(scroll).appendChild(el('div', { class: 'loading', text: '正在读取排班…' }));
      clear(head);
      return;
    }
    const rooms = App.rooms.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const days = App.days;
    const shifts = App.shifts;
    const gridWidth = `132px 58px ${rooms.map(() => 'minmax(108px, 1fr)').join(' ')}`;

    // ---------- 表头 ----------
    const headCells = [
      el('div', { class: 'gh gh-date' }, [
        el('span', { class: 'gh-name', text: `${App.month.year} 年 ${App.month.month} 月` }),
        el('span', { class: 'gh-sub', text: '日期 / 星期' }),
      ]),
      el('div', { class: 'gh gh-shift', text: '班次' }),
    ];
    for (const r of rooms) {
      const stat = (App.stats.rooms || []).find((x) => x.id === r.id) || { filled: 0, total: 0 };
      headCells.push(
        el('div', { class: 'gh gh-room', title: r.name, dataset: { room: r.id } }, [
          el('span', { class: 'gh-name', text: r.short || r.name }),
          el('span', { class: 'gh-sub', text: `${stat.filled}/${stat.total} 已排` }),
        ])
      );
    }
    headCells.push(el('div', { class: 'gh gh-fill' }));
    clear(head);
    head.style.gridTemplateColumns = gridWidth;
    for (const c of headCells) head.appendChild(c);

    // ---------- 表体 ----------
    clear(scroll);
    if (!days.length) {
      scroll.appendChild(el('div', { class: 'loading', text: '这个月没有日期范围，请到「科室设置」检查。' }));
      this.renderSide();
      return;
    }
    const body = el('div', { class: 'grid-body' });
    body.style.gridTemplateColumns = gridWidth;

    for (const day of days) {
      const dateCell = el('div', { class: `gc gc-date${day.isWeekend ? ' weekend' : ''}` }, [
        el('div', { class: 'date-num', text: `${day.day}日` }),
        el('div', { class: 'date-wd', text: day.weekdayName }),
      ]);
      if (shifts.length > 1) dateCell.style.gridRow = `span ${shifts.length}`;
      body.appendChild(dateCell);

      shifts.forEach((shift, si) => {
        const time = (App.month.shiftTimes || {})[`${day.date}|${shift.name}`] || {};
        const start = time.start ? time.start.slice(11, 16) : '';
        const end = time.end ? time.end.slice(16, 21) : '';
        body.appendChild(
          el('div', { class: `gc gc-shift${si === 0 ? ' gc-first' : ''}` }, [
            el('div', { class: 'shift-name', text: shift.name }),
            el('div', { class: 'shift-time', text: start && end ? `${start}-${end}` : '' }),
          ])
        );
        for (const room of rooms) body.appendChild(this.buildCell(day, shift, room, si === 0));
      });
    }

    scroll.appendChild(body);
    if (!this._onScroll) {
      this._onScroll = () => {
        const headNode = $('#gridHead');
        if (headNode) headNode.style.transform = `translateX(${-scroll.scrollLeft}px)`;
      };
    }
    // 用 addEventListener 而不是 onscroll 属性：语义更清楚，也方便测试里派发事件验证
    scroll.removeEventListener('scroll', this._onScroll);
    scroll.addEventListener('scroll', this._onScroll, { passive: true });
    this._onScroll();
    this.bindEvents(scroll);
    this.renderSide();
    this.renderBrush();
    this.syncModeUi();
  },

  buildCell(day, shift, room, firstShift) {
    const docId = App.slot(day.date, shift.name, room.id);
    const doc = docId ? App.doctor(docId) : null;
    const classes = ['gc', 'gc-cell'];
    if (shift.name === '上午') classes.push('am');
    if (day.isWeekend) classes.push('weekend');
    if (!doc) classes.push('empty');
    if (firstShift) classes.push('gc-first');
    const cell = el('div', {
      class: classes.join(' '),
      dataset: { date: day.date, shift: shift.name, room: room.id },
      title: `${day.date}（${day.weekdayName}）${shift.name} · ${room.name}`,
    });
    this.fillCell(cell, doc, day, { date: day.date, shift: shift.name, roomId: room.id });
    return cell;
  },

  fillCell(cell, doc, day, info) {
    clear(cell);
    cell.classList.toggle('empty', !doc);
    if (doc) {
      cell.style.background = tint(doc.color, day.isWeekend ? 0.26 : 0.14);
      cell.appendChild(el('span', { class: 'cell-name', text: doc.name, style: `color:${doc.color}` }));
      // 这一格的时间/间隔如果和班次默认不一样，左上角标出来（一样就不标，免得全是噪音）
      const slot = info || this.cellInfo(cell);
      const times = slot ? App.slotTime(App.slotKey(slot.date, slot.shift, slot.roomId)) : null;
      if (times) {
        const conf = (App.shifts || []).find((s) => s.name === slot.shift) || {};
        const startChanged = times.start !== (conf.start || '');
        const endChanged = times.end !== (conf.end || '');
        const perChanged = String(times.perInterval) !== String(conf.perInterval);
        const intervalChanged = String(times.interval) !== String(conf.interval);
        const differs = startChanged || endChanged || perChanged || intervalChanged;
        if (differs) {
          // 优先显示开始时间；只改了间隔/号数就显示那一项
          let text = times.start.slice(0, 5);
          if (!startChanged) {
            text = intervalChanged ? `${times.interval}分` : `${times.perInterval}号`;
          }
          const onlyCell = times.source === 'cell';
          const who = onlyCell ? '这一格单独设了' : `这位医生这天的${slot.shift}按自己的规律走`;
          cell.appendChild(
            el('span', {
              class: `badge badge-time${onlyCell ? ' badge-time-cell' : ''}`,
              text,
              title:
                `${who}：${times.start.slice(0, 5)}–${times.end.slice(0, 5)}，${times.perInterval} 号/${times.interval} 分钟`
                + (perChanged || intervalChanged ? '（和班次默认不同）' : ''),
            })
          );
        }
      }
      const problems = [];
      if (!doc.code) problems.push('缺编号');
      if (!doc.title) problems.push('缺号别');
      if (problems.length) cell.appendChild(el('span', { class: 'badge', text: '!', title: problems.join('、') }));
    } else {
      cell.style.background = '';
      const dash = el('span', { class: 'cell-empty' });
      dash.innerHTML = '&mdash;';
      cell.appendChild(dash);
    }
  },

  cellInfo(cell) {
    const d = cell.dataset;
    if (!d || !d.date) return null;
    return { date: d.date, shift: d.shift, roomId: d.room };
  },

  bindEvents(scroll) {
    const self = this;
    scroll.onmousedown = (event) => {
      if (event.button === 2) return;
      const cell = event.target.closest('.gc-cell');
      if (!cell) {
        App.setSelected(null);
        return;
      }
      const info = self.cellInfo(cell);
      if (!info) return;
      const current = App.slot(info.date, info.shift, info.roomId);
      const brush = App.brushId;

      if (App.mode !== 'paint' || !brush) {
        App.setSelected(info);
        return;
      }
      event.preventDefault();
      const clearInstead = current === brush;
      self._drag = { paintId: clearInstead ? null : brush, touched: new Set(), changed: false };
      self.paintCell(cell, clearInstead ? null : brush);
    };

    scroll.onmouseover = (event) => {
      if (!self._drag) return;
      const cell = event.target.closest('.gc-cell');
      if (!cell) return;
      self.paintCell(cell, self._drag.paintId);
    };

    scroll.oncontextmenu = (event) => {
      const cell = event.target.closest('.gc-cell');
      if (!cell) return;
      event.preventDefault();
      const info = self.cellInfo(cell);
      if (!info) return;
      App.setSelected(info);
      self.showContextMenu(event.clientX, event.clientY, info, cell);
    };
  },

  /** 只按当前医生字典刷新格子里的姓名与颜色（改姓名/颜色后用，不重建整张表） */
  renderGridNames() {
    const scroll = $('#gridScroll');
    if (!scroll) return;
    for (const cell of $$('.gc-cell', scroll)) {
      const info = this.cellInfo(cell);
      if (!info) continue;
      const docId = App.slot(info.date, info.shift, info.roomId);
      this.fillCell(cell, docId ? App.doctor(docId) : null, describeDate(info.date), info);
    }
  },

  paintCell(cell, doctorId) {
    const drag = this._drag;
    const info = this.cellInfo(cell);
    if (!info) return;
    const key = App.slotKey(info.date, info.shift, info.roomId);
    if (drag && drag.touched.has(key)) return;
    if (drag) drag.touched.add(key);
    App.applyChanges([{ date: info.date, shift: info.shift, roomId: info.roomId, doctorId }]);
    this.fillCell(cell, doctorId ? App.doctor(doctorId) : null, describeDate(info.date), info);
    this.updateHeaderAndSide();
  },

  endDrag() {
    if (this._drag) this._drag = null;
  },

  updateHeaderAndSide() {
    if (this._sideTimer) return;
    this._sideTimer = setTimeout(() => {
      this._sideTimer = null;
      const head = $('#gridHead');
      for (const [id, stat] of (App.stats.rooms || []).map((s) => [s.id, s])) {
        const node = head.querySelector(`.gh-room[data-room="${id}"] .gh-sub`);
        if (node) node.textContent = `${stat.filled}/${stat.total} 已排`;
      }
      this.renderSide();
    }, 80);
  },

  renderSelected() {
    const scroll = $('#gridScroll');
    if (!scroll) return;
    for (const cell of $$('.gc-cell.selected', scroll)) cell.classList.remove('selected');
    const sel = App.selected;
    if (!sel) return;
    const node = scroll.querySelector(
      `.gc-cell[data-date="${sel.date}"][data-shift="${sel.shift}"][data-room="${sel.roomId}"]`
    );
    if (node) node.classList.add('selected');
  },

  showContextMenu(x, y, info, cell) {
    const old = $('#ctxMenu');
    if (old) old.remove();
    const docId = App.slot(info.date, info.shift, info.roomId);
    const doc = docId ? App.doctor(docId) : null;
    const day = describeDate(info.date);
    const room = App.room(info.roomId);
    const menu = el('div', { class: 'ctx-menu', id: 'ctxMenu' });
    const add = (label, fn, disabled) => {
      const item = el('button', { class: 'ctx-item', text: label });
      if (disabled) item.disabled = true;
      else {
        item.onclick = (e) => {
          e.stopPropagation();
          menu.remove();
          fn();
        };
      }
      menu.appendChild(item);
    };

    add('清空这一格', () => {
      App.applyChanges([{ ...info, doctorId: null }]);
      this.fillCell(cell, null, day);
      this.updateHeaderAndSide();
    }, !doc);
    add(`清空「${room ? room.short || room.name : ''}」整列`, () => this.clearScope({ roomId: info.roomId }));

    // 单格出诊时间：优先级高于医生规律和班次默认
    const slotKey = App.slotKey(info.date, info.shift, info.roomId);
    const cellRule = (App.slotRules() || {})[slotKey];
    add(cellRule ? `改这一格的时间（现在 ${cellRule.start.slice(0, 5)}–${cellRule.end.slice(0, 5)}）` : '自定义这一格的时间…', () => {
      CellTimeRule.open(info);
    });
    if (cellRule) {
      add('清除这一格的时间设置', () => {
        CellTimeRule.info = info;
        CellTimeRule.clear();
      });
    }

    if (App.brushId) {
      const brush = App.doctor(App.brushId);
      add(`换成 ${brush ? brush.name : ''}`, () => {
        App.applyChanges([{ ...info, doctorId: App.brushId }]);
        this.fillCell(cell, brush, day);
        this.updateHeaderAndSide();
      }, docId === App.brushId);
    }
    if (doc) {
      add(`用 ${doc.name} 当画笔`, () => {
        App.brushId = doc.id;
        App.setMode('paint');
        App.emit({ type: 'brush' });
      });
    }
    menu.style.left = `${Math.min(x, window.innerWidth - 250)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - menu.childElementCount * 34 - 16)}px`;
    document.body.appendChild(menu);
  },

  clearScope(scope) {
    const changes = [];
    for (const [key, docId] of Object.entries(App.month.slots)) {
      const [date, shift, roomId] = key.split('|');
      if (scope.date && date !== scope.date) continue;
      if (scope.shift && shift !== scope.shift) continue;
      if (scope.roomId && roomId !== scope.roomId) continue;
      if (docId) changes.push({ date, shift, roomId, doctorId: null });
    }
    if (!changes.length) {
      toast('这一块本来就没有排班', 'ok');
      return;
    }
    App.applyChanges(changes);
    this.render();
    toast(`已清空 ${changes.length} 格`, 'ok');
  },

  renderSide() {
    const stats = App.stats;
    if (!stats) return;
    const pct = stats.total ? Math.round((stats.filled / stats.total) * 100) : 0;
    $('#progBar').style.width = `${pct}%`;
    $('#progText').textContent = `已排 ${stats.filled} / ${stats.total} 格（${pct}%），空 ${stats.empty} 格`;

    const warn = clear($('#warnList'));
    const missing = App.activeDoctors().filter((d) => !d.code || !d.title);
    if (missing.length) {
      warn.appendChild(
        el('div', {
          class: 'warn-item',
          text: `${missing.length} 位医生缺编号或号别：${missing.map((d) => d.name).join('、')}。导出的对应格会留空。`,
        })
      );
    }
    const idle = stats.doctors.filter((d) => d.total === 0);
    if (idle.length) {
      warn.appendChild(el('div', { class: 'warn-item', text: `本月还没排班：${idle.map((d) => d.name).join('、')}` }));
    }
    if (!warn.childElementCount) {
      warn.appendChild(
        el('div', { class: 'warn-item ok', text: '医生资料齐全，本月每人都有班。' })
      );
    }

    const dtable = clear($('#statDoctors'));
    const dt = el('table', { class: 'mini' });
    dt.appendChild(
      el('thead', null, [
        el('tr', null, [
          el('th', { text: '医生' }),
          el('th', { class: 'num', text: '上午' }),
          el('th', { class: 'num', text: '下午' }),
          el('th', { class: 'num', text: '合计' }),
        ]),
      ])
    );
    const dtb = el('tbody');
    for (const d of stats.doctors) {
      dtb.appendChild(
        el('tr', null, [
          el('td', null, [
            el('span', { class: 'doc-dot inline', style: `background:${d.color}` }),
            d.name,
          ]),
          el('td', { class: 'num', text: d.am }),
          el('td', { class: 'num', text: d.pm }),
          el('td', { class: 'num', text: d.total }),
        ])
      );
    }
    dt.appendChild(dtb);
    dtable.appendChild(dt);

    const rtable = clear($('#statRooms'));
    const rt = el('table', { class: 'mini' });
    rt.appendChild(el('thead', null, [el('tr', null, [el('th', { text: '诊室' }), el('th', { class: 'num', text: '已排 / 总数' })])]));
    const rtb = el('tbody');
    for (const r of stats.rooms) {
      rtb.appendChild(
        el('tr', null, [
          el('td', { text: r.short || r.name, title: r.name }),
          el('td', { class: 'num', text: `${r.filled} / ${r.total}` }),
        ])
      );
    }
    rt.appendChild(rtb);
    rtable.appendChild(rt);

    this.renderPalette();
  },

  /** 顶部的排班医生选择条 */
  renderPalette() {
    const wrap = clear($('#palette'));
    const doctors = App.activeDoctors();
    if (!doctors.length) {
      wrap.appendChild(el('span', { class: 'hint', text: '还没有医生，去「医生资料」新增。' }));
      return;
    }
    for (const d of doctors) {
      const active = App.brushId === d.id;
      const chip = el(
        'button',
        {
          class: `doc-chip${active ? ' active' : ''}`,
          title: `${d.name}　门诊编号：${d.code || '（空）'}　号别：${d.title || '（空）'}　诊室：${d.room || '（空）'}`,
        },
        [
          el('span', { class: 'doc-dot', style: `background:${d.color}` }),
          el('span', { class: 'doc-chip-name', text: d.name || '（未命名）' }),
        ]
      );
      chip.onclick = () => {
        App.setBrush(d.id);
        if (App.mode !== 'paint') App.setMode('paint');
      };
      wrap.appendChild(chip);
    }
  },

  renderBrush() {
    const bar = $('#brushBar');
    const empty = $('#brushEmpty');
    const existing = bar.querySelector('.brush-chip');
    if (existing) existing.remove();
    if (!App.brushId) {
      if (empty) empty.hidden = false;
      return;
    }
    const doc = App.doctor(App.brushId);
    if (!doc) return;
    if (empty) empty.hidden = true;
    bar.appendChild(
      el('span', { class: 'brush-chip' }, [
        el('span', { class: 'brush-dot', style: `background:${doc.color}` }),
        el('span', { text: doc.name }),
        el('span', { class: 'brush-meta', text: `${doc.title || '未填号别'} · ${doc.room || '未设诊室'}` }),
        el('button', {
          class: 'btn btn-sm btn-ghost',
          text: '取消',
          onclick: () => {
            App.brushId = null;
            App.emit({ type: 'brush' });
          },
        }),
      ])
    );
  },

  syncModeUi() {
    for (const seg of $$('#modeSwitch .seg')) seg.classList.toggle('active', seg.dataset.mode === App.mode);
    $('#btnUndo').disabled = !App.canUndo;
    $('#btnRedo').disabled = !App.canRedo;
  },
};

document.addEventListener('mouseup', () => ScheduleView.endDrag());
document.addEventListener('mousedown', (event) => {
  const menu = $('#ctxMenu');
  if (menu && !menu.contains(event.target)) menu.remove();
});
