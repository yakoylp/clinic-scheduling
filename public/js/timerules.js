'use strict';
/**
 * 医生级「出诊时间规律」编辑弹窗。
 *
 * 用来处理这类个例：某位医生周一到周五上午 8:30 开始，周六日 8:00 开始。
 * 配好后排班和导出都会自动按这条规律算时间，不用每月重设。
 */

const DAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
const PRESETS = [
  { label: '工作日（一~五）', days: [1, 2, 3, 4, 5] },
  { label: '周末（六日）', days: [0, 6] },
  { label: '每天', days: [0, 1, 2, 3, 4, 5, 6] },
];

/** 把内部规则整理成界面用的行：一个规则可能同时含上午/下午 */
function rulesToRows(rules) {
  return (Array.isArray(rules) ? rules : []).map((rule) => {
    const morning = (rule.shifts && rule.shifts['上午']) || {};
    const afternoon = (rule.shifts && rule.shifts['下午']) || {};
    return {
      days: Array.isArray(rule.days) ? rule.days.slice() : [],
      morning: { start: hhmm(morning.start), end: hhmm(morning.end) },
      afternoon: { start: hhmm(afternoon.start), end: hhmm(afternoon.end) },
    };
  });
}

/** 新行默认填上班次的当前时间，用户只改要变的那一格 */
function blankRow(days) {
  const row = { days: days.slice(), morning: { start: '', end: '' }, afternoon: { start: '', end: '' } };
  for (const [key, shiftName] of [['morning', '上午'], ['afternoon', '下午']]) {
    const conf = (App.shifts || []).find((s) => s.name === shiftName) || {};
    row[key].start = hhmm(conf.start);
    row[key].end = hhmm(conf.end);
  }
  return row;
}

/** HH:MM:SS -> HH:MM（输入框用） */
function hhmm(value) {
  return value ? String(value).slice(0, 5) : '';
}

/** 行 -> 内部规则（空的不写入） */
function rowsToRules(rows) {
  const out = [];
  for (const row of rows) {
    const days = [...new Set(row.days.map(Number))].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
    if (!days.length) continue;
    const shifts = {};
    if (row.morning.start || row.morning.end) {
      shifts['上午'] = { start: row.morning.start, end: row.morning.end };
    }
    if (row.afternoon.start || row.afternoon.end) {
      shifts['下午'] = { start: row.afternoon.start, end: row.afternoon.end };
    }
    if (!Object.keys(shifts).length) continue;
    out.push({ days, shifts });
  }
  return out;
}

/** 医生列表里显示的摘要文字 */
function summarizeRules(rules) {
  return rules
    .map((rule) => {
      const days = rule.days.slice().sort((a, b) => a - b).map((d) => DAY_LABELS[d]).join('');
      const parts = Object.entries(rule.shifts || {}).map(([name, t]) => {
        const range = [hhmm(t.start), hhmm(t.end)].filter(Boolean).join('–');
        return `${name} ${range}`;
      });
      return `周${days}：${parts.join('，')}`;
    })
    .join('\n');
}

const TimeRules = {
  doctor: null,
  rows: [],

  open(doctor) {
    this.doctor = doctor;
    this.rows = rulesToRows(doctor.timeRules);
    if (!this.rows.length) this.rows.push(blankRow([1, 2, 3, 4, 5]));
    $('#rulesTitle').textContent = `出诊时间规律 — ${doctor.name || '（未命名医生）'}`;
    Modals.open('modalRules');
    this.render();
  },

  render() {
    const body = clear($('#rulesBody'));

    body.appendChild(
      el('p', {
        class: 'sub',
        text: '默认情况下这位医生跟着「科室设置」里的班次时间出诊。如果他有固定习惯（比如工作日 8:30 开始、周末 8:00 开始），在这里按星期几配好，排班和导出都会自动用这个时间，不用每个月重设。留空的项表示沿用班次默认时间。',
      })
    );

    const presetBar = el('div', { class: 'preset-bar' }, [
      el('span', { class: 'lbl', text: '快捷添加：' }),
    ]);
    for (const p of PRESETS) {
      presetBar.appendChild(
        el('button', {
          class: 'btn btn-sm btn-ghost',
          text: p.label,
          onclick: () => {
            this.rows.push(blankRow(p.days));
            this.render();
          },
        })
      );
    }
    body.appendChild(presetBar);

    if (!this.rows.length) {
      body.appendChild(el('div', { class: 'empty-block', text: '这条医生没有特殊规律，完全跟班次默认时间走。' }));
    }

    this.rows.forEach((row, index) => {
      body.appendChild(this.ruleCard(row, index));
    });
  },

  ruleCard(row, index) {
    const card = el('div', { class: 'rule-card' });

    // 星期选择
    const head = el('div', { class: 'rule-head' }, [
      el('span', { class: 'rule-no', text: `规则 ${index + 1}` }),
    ]);
    const dayBox = el('div', { class: 'day-toggles' });
    for (let d = 0; d < 7; d += 1) {
      const on = row.days.includes(d);
      const btn = el('button', {
        class: `day-btn${on ? ' active' : ''}`,
        text: DAY_LABELS[d],
        title: `星期${DAY_LABELS[d]}`,
      });
      btn.onclick = () => {
        const i = row.days.indexOf(d);
        if (i >= 0) row.days.splice(i, 1);
        else row.days.push(d);
        this.render();
      };
      dayBox.appendChild(btn);
    }
    head.appendChild(dayBox);
    head.appendChild(
      el('button', {
        class: 'btn btn-sm btn-danger',
        text: '删除这条',
        onclick: () => {
          this.rows.splice(index, 1);
          this.render();
        },
      })
    );
    card.appendChild(head);

    // 上午 / 下午时间
    for (const [shiftName, key] of [['上午', 'morning'], ['下午', 'afternoon']]) {
      const conf = (App.shifts || []).find((s) => s.name === shiftName) || {};
      const line = el('div', { class: 'rule-time-line' }, [
        el('span', { class: 'rule-shift', text: shiftName }),
      ]);
      for (const [field, label] of [['start', '开始'], ['end', '结束']]) {
        line.appendChild(el('span', { class: 'lbl', text: label }));
        const input = el('input', {
          class: 'input sm time-input',
          type: 'time',
          value: row[key][field] || '',
        });
        input.oninput = () => {
          row[key][field] = input.value;
        };
        line.appendChild(input);
        if (conf[field]) {
          line.appendChild(
            el('button', {
              class: 'btn btn-sm btn-ghost',
              text: `班次默认 ${hhmm(conf[field])}`,
              title: '点一下恢复成班次默认时间',
              onclick: () => {
                row[key][field] = hhmm(conf[field]);
                this.render();
              },
            })
          );
        }
      }
      // 和班次默认完全一样时提示一下，避免用户以为没生效
      const sameAsDefault =
        hhmm(conf.start) === row[key].start && hhmm(conf.end) === row[key].end;
      if (sameAsDefault) {
        line.appendChild(el('span', { class: 'rule-hint', text: '与班次默认相同' }));
      }
      card.appendChild(line);
    }

    return card;
  },

  async save() {
    const built = rowsToRules(this.rows);
    const emptyRows = this.rows.filter((r) => {
      const hasTime = r.morning.start || r.morning.end || r.afternoon.start || r.afternoon.end;
      return hasTime && !r.days.length;
    });
    if (emptyRows.length) {
      toast('有规则填了时间但没选星期几', 'err');
      return;
    }
    const invalid = [];
    for (const row of this.rows) {
      for (const key of ['morning', 'afternoon']) {
        for (const field of ['start', 'end']) {
          const v = row[key][field];
          if (v && !/^\d{2}:\d{2}$/.test(v)) invalid.push(v);
        }
      }
    }
    if (invalid.length) {
      toast(`时间格式不对：${invalid[0]}`, 'err');
      return;
    }
    this.doctor.timeRules = built;
    Modals.close('modalRules');
    App.dirty = true;
    window.api.setDirty(true);
    await DoctorsView.save(true);
    await App.loadMonth(App.ym);
    ScheduleView.render();
    toast(built.length ? `已保存 ${this.doctor.name} 的 ${built.length} 条时间规律` : `已清除 ${this.doctor.name} 的时间规律`, 'ok');
  },

  clearAll() {
    if (!window.confirm('清空这位医生的全部时间规律？之后他完全跟班次默认时间走。')) return;
    this.rows = [];
    this.render();
  },

  cancel() {
    Modals.close('modalRules');
    this.doctor = null;
    this.rows = [];
  },
};

document.addEventListener('DOMContentLoaded', () => {
  $('#btnRulesClose').onclick = () => TimeRules.cancel();
  $('#btnRulesCancel').onclick = () => TimeRules.cancel();
  $('#btnRulesSave').onclick = () => TimeRules.save();
  $('#btnRulesClear').onclick = () => TimeRules.clearAll();
  $('#btnCellTimeClose').onclick = () => CellTimeRule.cancel();
  $('#btnCellTimeCancel').onclick = () => CellTimeRule.cancel();
  $('#btnCellTimeSave').onclick = () => CellTimeRule.save();
  $('#btnCellTimeClear').onclick = () => CellTimeRule.clear();
});

/**
 * 单个格子的出诊时间设置。
 * 优先级最高：只改这一格，不动医生的周规律，也不动班次默认。
 */
const CellTimeRule = {
  info: null,
  rule: null,

  open(info) {
    this.info = info;
    const stored = (App.slotRules() || {})[`${info.date}|${info.shift}|${info.roomId}`] || null;
    this.rule = { start: stored ? stored.start : '', end: stored ? stored.end : '' };
    Modals.open('modalCellTime');
    this.render();
  },

  render() {
    const info = this.info;
    const day = describeDate(info.date);
    const room = App.room(info.roomId);
    const docId = App.slot(info.date, info.shift, info.roomId);
    const doc = docId ? App.doctor(docId) : null;
    const conf = (App.shifts || []).find((s) => s.name === info.shift) || {};
    const effective = App.slotTime(App.slotKey(info.date, info.shift, info.roomId)) || {};

    $('#cellTimeTitle').textContent = `这一格的出诊时间 — ${day.month}月${day.day}日 ${day.weekdayName} ${info.shift}`;

    const body = clear($('#cellTimeBody'));
    const kv = el('dl', { class: 'kv' });
    const row = (k, v) => {
      kv.appendChild(el('dt', { text: k }));
      kv.appendChild(el('dd', { text: v }));
    };
    row('诊室', room ? room.name : '（已删除）');
    row('医生', doc ? doc.name : '（这一格还没排人）');
    row('班次默认', conf.start ? `${hhmm(conf.start)}–${hhmm(conf.end)}` : '（未设置）');
    row('当前实际', effective.start ? `${hhmm(effective.start)}–${hhmm(effective.end)}` : '—');
    body.appendChild(kv);

    body.appendChild(
      el('p', {
        class: 'sub',
        text: '只对这一个格子生效，不动这位医生的周规律，也不动班次默认时间。留空的项表示沿用上层（医生的规律或班次默认）。',
      })
    );

    const form = el('div', { class: 'rule-time-line' });
    for (const [field, label] of [['start', '开始'], ['end', '结束']]) {
      form.appendChild(el('span', { class: 'rule-shift', text: label }));
      const input = el('input', {
        class: 'input sm time-input',
        type: 'time',
        value: this.rule[field] || '',
      });
      input.oninput = () => {
        this.rule[field] = input.value;
      };
      form.appendChild(input);
      if (conf[field]) {
        form.appendChild(
          el('button', {
            class: 'btn btn-sm btn-ghost',
            text: `班次默认 ${hhmm(conf[field])}`,
            onclick: () => {
              this.rule[field] = hhmm(conf[field]);
              this.render();
            },
          })
        );
      }
    }
    body.appendChild(form);

    // 这位医生自己的规律时间，方便一键照抄
    if (doc) {
      const habit = doctorHabitTime(doc, day.weekday, info.shift, App.shifts);
      if (habit) {
        body.appendChild(
          el('div', { class: 'rule-time-line' }, [
            el('button', {
              class: 'btn btn-sm btn-ghost',
              text: `用 ${doc.name} 的规律 ${hhmm(habit.start)}–${hhmm(habit.end)}`,
              onclick: () => {
                this.rule.start = hhmm(habit.start);
                this.rule.end = hhmm(habit.end);
                this.render();
              },
            }),
          ])
        );
      }
    }

    if (App.slotRules()[`${info.date}|${info.shift}|${info.roomId}`]) {
      body.appendChild(
        el('p', { class: 'rule-hint', text: '这一格当前已单独设过时间，点「清除这一格的时间设置」可以还原。' })
      );
    }
  },

  async save() {
    const start = this.rule.start;
    const end = this.rule.end;
    if (!start && !end) {
      toast('开始和结束都空着等于没设置，可以点「清除这一格的时间设置」', 'warn');
      return;
    }
    for (const v of [start, end]) {
      if (v && !/^\d{2}:\d{2}$/.test(v)) {
        toast(`时间格式不对：${v}`, 'err');
        return;
      }
    }
    try {
      await call(window.api.month.setSlotTime, App.ym, this.info.date, this.info.shift, this.info.roomId, {
        start: start ? `${start}:00` : '',
        end: end ? `${end}:00` : '',
      });
      await App.loadMonth(App.ym);
      ScheduleView.render();
      Modals.close('modalCellTime');
      toast(`${App.ym} 这一格的时间已设为 ${start || '默认'}–${end || '默认'}`, 'ok');
    } catch (err) {
      toast(`设置失败：${err.message}`, 'err');
    }
  },

  async clear() {
    try {
      await call(window.api.month.clearSlotTime, App.ym, this.info.date, this.info.shift, this.info.roomId);
      await App.loadMonth(App.ym);
      ScheduleView.render();
      Modals.close('modalCellTime');
      toast('已清除这一格的时间设置', 'ok');
    } catch (err) {
      toast(`清除失败：${err.message}`, 'err');
    }
  },

  cancel() {
    Modals.close('modalCellTime');
    this.info = null;
    this.rule = null;
  },
};

/** 取医生在某个星期几、某个班次的规律时间（没配就返回 null） */
function doctorHabitTime(doctor, weekday, shiftName, shifts) {
  const conf = (shifts || []).find((s) => s.name === shiftName) || {};
  for (const rule of (doctor && doctor.timeRules) || []) {
    if (!Array.isArray(rule.days) || !rule.days.includes(weekday)) continue;
    const hit = rule.shifts && rule.shifts[shiftName];
    if (!hit) continue;
    return { start: hit.start || conf.start, end: hit.end || conf.end, customized: true };
  }
  return null;
}
