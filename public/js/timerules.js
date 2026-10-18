'use strict';
/**
 * 医生级「出诊时间规律」编辑弹窗。
 *
 * 用来处理这类个例：某位医生周一到周五上午 8:30 开始，周六日 8:00 开始。
 * 配好后排班和导出都会自动按这条规律算时间，不用每月重设。
 */

const DAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
/** 一个规则卡里有两块：上午 / 下午 */
const SHIFT_KEYS = [['上午', 'morning'], ['下午', 'afternoon']];
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
      morning: toFields(morning),
      afternoon: toFields(afternoon),
    };
  });
}

/** 内部值 -> 输入框值（时间取 HH:MM，数字取字符串） */
function toFields(t) {
  return {
    start: hhmm(t.start),
    end: hhmm(t.end),
    perInterval: numText(t.perInterval),
    interval: numText(t.interval),
  };
}

/** 数字 -> 输入框文本；null/undefined 表示「这一层没设」 */
function numText(v) {
  return v === null || v === undefined || v === '' ? '' : String(v);
}

/** 新行默认填上班次的当前时间，用户只改要变的那一格 */
function blankRow(days) {
  const row = {
    days: days.slice(),
    morning: { start: '', end: '', perInterval: '', interval: '' },
    afternoon: { start: '', end: '', perInterval: '', interval: '' },
  };
  for (const [key, shiftName] of [['morning', '上午'], ['afternoon', '下午']]) {
    const conf = (App.shifts || []).find((s) => s.name === shiftName) || {};
    row[key].start = hhmm(conf.start);
    row[key].end = hhmm(conf.end);
    row[key].perInterval = numText(conf.perInterval);
    row[key].interval = numText(conf.interval);
  }
  return row;
}

/** HH:MM:SS -> HH:MM（输入框用） */
function hhmm(value) {
  return value ? String(value).slice(0, 5) : '';
}

/**
 * 一个班次这一行里，有哪几项和班次默认不同（只有这些会写进规则）。
 * 注意：空字符串表示「沿用下层」，**不算改过**——否则从已存规则读回来的行
 * （未设置的项是空串）会被误判成「改了这个班次」，进而误报星期几冲突。
 */
function changedFields(block, conf) {
  const out = {};
  const consider = (field, value, base) => {
    const cur = value === null || value === undefined ? '' : String(value);
    if (cur === '' || cur === base) return;
    out[field] = cur;
  };
  consider('start', block.start, hhmm(conf.start));
  consider('end', block.end, hhmm(conf.end));
  consider('perInterval', block.perInterval, numText(conf.perInterval));
  consider('interval', block.interval, numText(conf.interval));
  return out;
}

/** 取某个班次的默认定义 */
function shiftConf(shiftName) {
  return (App.shifts || []).find((s) => s.name === shiftName) || {};
}

/** 这个班次这一行有没有真的改过任何一项 */
function blockChanged(block, shiftName) {
  return Object.keys(changedFields(block, shiftConf(shiftName))).length > 0;
}

/** 行 -> 内部规则（和班次默认一样的不写入，保证「没配规则」的医生不留空壳规则） */
function rowsToRules(rows) {
  const out = [];
  for (const row of rows) {
    const days = [...new Set(row.days.map(Number))].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
    if (!days.length) continue;
    const shifts = {};
    for (const [key, shiftName] of [['morning', '上午'], ['afternoon', '下午']]) {
      const conf = (App.shifts || []).find((s) => s.name === shiftName) || {};
      const diff = changedFields(row[key], conf);
      if (!Object.keys(diff).length) continue;
      shifts[shiftName] = {
        start: diff.start ? (diff.start.length === 5 ? `${diff.start}:00` : diff.start) : '',
        end: diff.end ? (diff.end.length === 5 ? `${diff.end}:00` : diff.end) : '',
        perInterval: diff.perInterval || null,
        interval: diff.interval || null,
      };
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
        const extra = [];
        if (t.perInterval !== null && t.perInterval !== undefined && t.perInterval !== '') {
          extra.push(`${t.perInterval} 号/间隔`);
        }
        if (t.interval !== null && t.interval !== undefined && t.interval !== '') {
          extra.push(`${t.interval} 分钟`);
        }
        return `${name} ${[range, extra.join('、')].filter(Boolean).join('，')}`;
      });
      return `周${days}：${parts.join('；')}`;
    })
    .join('\n');
}

const TimeRules = {
  doctor: null,
  rows: [],

  open(doctor) {
    this.doctor = doctor;
    this.rows = rulesToRows(doctor.timeRules);
    if (!this.rows.length) this.rows = [];
    $('#rulesTitle').textContent = `出诊时间规律 — ${doctor.name || '（未命名医生）'}`;
    Modals.open('modalRules');
    this.render();
  },

  render() {
    const body = clear($('#rulesBody'));

    body.appendChild(
      el('p', {
        class: 'sub',
        text: '默认情况下这位医生跟着「科室设置」里的班次出诊。有固定习惯就在这里按星期几配好，'
          + '一条规律管一个「星期几 + 班次」组合，可以加任意多条；排班和导出都会自动按这些规律算，不用每个月重设。'
          + '留空的项表示沿用班次默认。',
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
    // 自己挑星期几的单条规律，不限那三个模板
    presetBar.appendChild(
      el('button', {
        class: 'btn btn-sm btn-primary',
        text: '＋ 新增一条规律',
        title: '新增一张空白规则卡，自己勾星期几',
        onclick: () => {
          // 默认勾上还没被占用的那一天，省得和现有规律打架
          const used = new Set();
          for (const r of this.rows) for (const d of r.days) used.add(d);
          const free = [1, 2, 3, 4, 5, 6, 0].find((d) => !used.has(d));
          this.rows.push(blankRow(free === undefined ? [] : [free]));
          this.render();
        },
      })
    );
    body.appendChild(presetBar);

    if (!this.rows.length) {
      body.appendChild(el('div', { class: 'empty-block', text: '这位医生没有特殊规律，完全跟班次默认走。' }));
    }

    this.rows.forEach((row, index) => {
      body.appendChild(this.ruleCard(row, index));
    });

    // 冲突提示：同一个「星期几 + 班次」被多条规律重复设置时，只有第一条生效，这里提前说出来
    const conflicts = this.findConflicts(this.rows);
    if (conflicts.length) {
      body.appendChild(
        el('div', { class: 'rule-conflict' }, [
          el('b', { text: '⚠ 有重复设置：' }),
          el('span', {
            text:
              conflicts.map((c) => `周${DAY_LABELS[c.weekday]} ${c.shift}`).join('、')
              + ' 被多条规律重复设置，只有从上往下第一条会生效。请合并或删掉多余的。',
          }),
        ])
      );
    }
  },

  /**
   * 找出「同一个星期几 + 同一个班次」被多条规律同时设置的情况。
   * 规则是按顺序第一条命中的，重复设置会让后面的形同虚设，所以要提示。
   */
  findConflicts(rows) {
    const seen = new Map();
    const out = [];
    for (const row of rows) {
      for (const day of row.days) {
        for (const [shiftName, key] of SHIFT_KEYS) {
          // 只有「真的改了值」才算设置了这个班次
          if (!blockChanged(row[key], shiftName)) continue;
          const k = `${day}|${shiftName}`;
          if (seen.has(k)) {
            if (!out.some((c) => c.weekday === day && c.shift === shiftName)) {
              out.push({ weekday: day, shift: shiftName, rules: [seen.get(k), row] });
            }
          } else {
            seen.set(k, row);
          }
        }
      }
    }
    return out;
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

    // 上午 / 下午：第一行起止时间，第二行两个间隔参数
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
      card.appendChild(line);

      // 第二行：每个时间间隔号数 / 时间间隔（分钟）
      const line2 = el('div', { class: 'rule-time-line rule-time-line-2' }, [
        el('span', { class: 'rule-shift', text: '' }),
      ]);
      for (const [field, label, unit] of [['perInterval', '号数', '个/间隔'], ['interval', '间隔', '分钟']]) {
        line2.appendChild(el('span', { class: 'lbl', text: label }));
        const input = el('input', {
          class: 'input sm num-input',
          type: 'number',
          min: '0',
          step: field === 'interval' ? '1' : '1',
          value: row[key][field] || '',
        });
        input.oninput = () => {
          row[key][field] = input.value;
        };
        line2.appendChild(input);
        line2.appendChild(el('span', { class: 'rule-hint', text: unit }));
        if (conf[field] !== undefined && conf[field] !== null && conf[field] !== '') {
          line2.appendChild(
            el('button', {
              class: 'btn btn-sm btn-ghost',
              text: `班次默认 ${conf[field]}`,
              title: '点一下恢复成班次默认',
              onclick: () => {
                row[key][field] = numText(conf[field]);
                this.render();
              },
            })
          );
        }
      }
      card.appendChild(line2);

      // 这一块没改动任何一项时提示一下，避免用户以为填了却没生效
      if (!blockChanged(row[key], shiftName)) {
        line2.appendChild(el('span', { class: 'rule-hint', text: '与班次默认相同' }));
      }
    }

    return card;
  },

  async save() {
    const built = rowsToRules(this.rows);
    // 改了值却没勾星期几的规则不可能生效，拦下来
    const emptyRows = this.rows.filter(
      (r) => (blockChanged(r.morning, '上午') || blockChanged(r.afternoon, '下午')) && !r.days.length
    );
    if (emptyRows.length) {
      toast('有规则改了值但没勾星期几，请勾上或删掉这条', 'err');
      return;
    }
    const invalid = [];
    for (const row of this.rows) {
      for (const key of ['morning', 'afternoon']) {
        for (const field of ['start', 'end']) {
          const v = row[key][field];
          if (v && !/^\d{2}:\d{2}$/.test(v)) invalid.push(`时间 ${v}`);
        }
        for (const field of ['perInterval', 'interval']) {
          const v = row[key][field];
          if (v && (!Number.isFinite(Number(v)) || Number(v) <= 0)) invalid.push(`${field === 'interval' ? '间隔' : '号数'} ${v}`);
        }
      }
    }
    if (invalid.length) {
      toast(`填得不对：${invalid[0]}`, 'err');
      return;
    }
    // 同一个「星期几 + 班次」被多条规律重复设置时，后面的永远不会生效 —— 说清楚，别让它悄悄不生效
    const conflicts = this.findConflicts(this.rows);
    if (conflicts.length) {
      const names = conflicts.map((c) => `周${DAY_LABELS[c.weekday]} ${c.shift}`).join('、');
      toast(`这些被多条规则重复设置，请先合并或删掉多余的：${names}`, 'err');
      return;
    }

    // 一行都没改的和班次默认完全一样，存进去也只是空壳，跳过并告知用户
    const skipped = this.rows.length - built.length;

    // 按 id 找当前快照里的那位医生再写：弹窗开着期间如果快照被重新加载过，
    // 手里这个引用可能已经不是数组里的对象了，直接写会丢掉改动
    const target = (App.snapshot.doctors || []).find((d) => d.id === this.doctor.id) || this.doctor;
    target.timeRules = built;
    Modals.close('modalRules');
    App.dirty = true;
    window.api.setDirty(true);
    await DoctorsView.save(true);
    await App.loadMonth(App.ym);
    ScheduleView.render();
    const skippedNote = skipped > 0 ? `（另有 ${skipped} 条和班次默认完全相同，已跳过）` : '';
    toast(
      built.length
        ? `已保存 ${this.doctor.name} 的 ${built.length} 条时间规律${skippedNote}`
        : `已清除 ${this.doctor.name} 的时间规律${skippedNote}`,
      'ok'
    );
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
    this.rule = { start: '', end: '', perInterval: '', interval: '' };
    if (stored) {
      this.rule.start = stored.start || '';
      this.rule.end = stored.end || '';
      this.rule.perInterval = numText(stored.perInterval);
      this.rule.interval = numText(stored.interval);
    }
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
    row('班次默认', conf.start ? `${hhmm(conf.start)}–${hhmm(conf.end)}，${conf.perInterval} 号/${conf.interval} 分钟` : '（未设置）');
    row(
      '当前实际',
      effective.start
        ? `${hhmm(effective.start)}–${hhmm(effective.end)}，${effective.perInterval} 号/${effective.interval} 分钟`
        : '—'
    );
    body.appendChild(kv);

    body.appendChild(
      el('p', {
        class: 'sub',
        text: '只对这一个格子生效，不动这位医生的周规律，也不动班次默认。留空的项表示沿用上层（医生的规律或班次默认），可以只改其中一项。',
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

    // 第二行：两个间隔参数
    const form2 = el('div', { class: 'rule-time-line' });
    for (const [field, label, unit] of [['perInterval', '号数', '个/间隔'], ['interval', '间隔', '分钟']]) {
      form2.appendChild(el('span', { class: 'rule-shift', text: label }));
      const input = el('input', {
        class: 'input sm num-input',
        type: 'number',
        min: '0',
        value: this.rule[field] || '',
      });
      input.oninput = () => {
        this.rule[field] = input.value;
      };
      form2.appendChild(input);
      form2.appendChild(el('span', { class: 'rule-hint', text: unit }));
      if (conf[field] !== undefined && conf[field] !== null && conf[field] !== '') {
        form2.appendChild(
          el('button', {
            class: 'btn btn-sm btn-ghost',
            text: `班次默认 ${conf[field]}`,
            onclick: () => {
              this.rule[field] = numText(conf[field]);
              this.render();
            },
          })
        );
      }
    }
    body.appendChild(form2);

    // 这位医生自己的规律，方便一键照抄
    if (doc) {
      const habit = doctorHabitTime(doc, day.weekday, info.shift, App.shifts);
      if (habit) {
        body.appendChild(
          el('div', { class: 'rule-time-line' }, [
            el('button', {
              class: 'btn btn-sm btn-ghost',
              text: `用 ${doc.name} 的规律 ${hhmm(habit.start)}–${hhmm(habit.end)}，${habit.perInterval} 号/${habit.interval} 分钟`,
              onclick: () => {
                this.rule.start = hhmm(habit.start);
                this.rule.end = hhmm(habit.end);
                this.rule.perInterval = numText(habit.perInterval);
                this.rule.interval = numText(habit.interval);
                this.render();
              },
            }),
          ])
        );
      }
    }

    if (App.slotRules()[`${info.date}|${info.shift}|${info.roomId}`]) {
      body.appendChild(
        el('p', { class: 'rule-hint', text: '这一格当前已单独设过，点「清除这一格的时间设置」可以还原。' })
      );
    }
  },

  async save() {
    const start = this.rule.start;
    const end = this.rule.end;
    const perInterval = this.rule.perInterval;
    const interval = this.rule.interval;
    if (!start && !end && !perInterval && !interval) {
      toast('四项都空着等于没设置，可以点「清除这一格的时间设置」', 'warn');
      return;
    }
    for (const v of [start, end]) {
      if (v && !/^\d{2}:\d{2}$/.test(v)) {
        toast(`时间格式不对：${v}`, 'err');
        return;
      }
    }
    for (const [v, label] of [[perInterval, '每个时间间隔号数'], [interval, '时间间隔（分钟）']]) {
      if (v && (!Number.isFinite(Number(v)) || Number(v) <= 0)) {
        toast(`${label}要填正数：${v}`, 'err');
        return;
      }
    }
    try {
      await call(window.api.month.setSlotTime, App.ym, this.info.date, this.info.shift, this.info.roomId, {
        start: start ? `${start}:00` : '',
        end: end ? `${end}:00` : '',
        perInterval: perInterval || null,
        interval: interval || null,
      });
      await App.loadMonth(App.ym);
      ScheduleView.render();
      Modals.close('modalCellTime');
      const parts = [];
      if (start || end) parts.push(`${start || '默认'}–${end || '默认'}`);
      if (perInterval) parts.push(`${perInterval} 号/间隔`);
      if (interval) parts.push(`${interval} 分钟`);
      toast(`这一格已设为 ${parts.join('，')}`, 'ok');
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

/** 取医生在某个星期几、某个班次的规律（没配就返回 null） */
function doctorHabitTime(doctor, weekday, shiftName, shifts) {
  const conf = (shifts || []).find((s) => s.name === shiftName) || {};
  for (const rule of (doctor && doctor.timeRules) || []) {
    if (!Array.isArray(rule.days) || !rule.days.includes(weekday)) continue;
    const hit = rule.shifts && rule.shifts[shiftName];
    if (!hit) continue;
    return {
      start: hit.start || conf.start,
      end: hit.end || conf.end,
      perInterval: hit.perInterval === null || hit.perInterval === undefined ? conf.perInterval : hit.perInterval,
      interval: hit.interval === null || hit.interval === undefined ? conf.interval : hit.interval,
      customized: true,
    };
  }
  return null;
}
