'use strict';
/** 弹窗：导入、导出、说明 */

const Modals = {
  open(id) {
    const node = $(`#${id}`);
    if (node) node.hidden = false;
  },
  close(id) {
    const node = $(`#${id}`);
    if (node) node.hidden = true;
  },
  closeAll() {
    for (const m of $$('.modal')) m.hidden = true;
  },
};

/* ---------------- 导入 ---------------- */
const ImportFlow = {
  file: null,
  preview: null,

  async start(presetFile) {
    this.file = presetFile || null;
    this.preview = null;
    Modals.open('modalImport');
    clear($('#importBody')).appendChild(el('div', { class: 'loading', text: '正在选择文件…' }));
    $('#btnImportConfirm').disabled = true;
    if (!this.file) {
      try {
        this.file = await call(window.api.legacy.pick, App.snapshot.paths.root);
      } catch (err) {
        toast(`打开文件失败：${err.message}`, 'err');
      }
    }
    if (!this.file) {
      Modals.close('modalImport');
      return;
    }
    await this.loadPreview();
  },

  async loadPreview() {
    const body = clear($('#importBody'));
    body.appendChild(el('div', { class: 'loading', text: '正在解析排班表…' }));
    try {
      this.preview = await call(window.api.legacy.preview, this.file);
    } catch (err) {
      clear(body).appendChild(el('div', { class: 'warn-item error', text: `解析失败：${err.message}` }));
      return;
    }
    const p = this.preview;
    clear(body);

    const kv = el('dl', { class: 'kv' });
    const row = (k, v) => {
      kv.appendChild(el('dt', { text: k }));
      kv.appendChild(el('dd', { text: v }));
    };
    row('文件', this.file);
    row('识别月份', `${p.year} 年 ${p.month} 月`);
    row('有排班的日期', `${p.days.length} 天（${p.days[0] || '—'} ~ ${p.days[p.days.length - 1] || '—'}）`);
    row('排班格数', `${Object.keys(p.assignments).length} 格，涉及医生 ${p.doctors.length} 位`);
    row('诊室列', p.rooms.map((r) => `${r.name}${r.doctor ? `（常驻 ${r.doctor}）` : ''}`).join('、') || '未识别');
    body.appendChild(kv);

    if (p.anomalies && p.anomalies.length) {
      body.appendChild(el('h4', { text: `跨诊室替班提醒（${p.anomalies.length} 条）` }));
      const list = el('div', { class: 'issue-list' });
      for (const a of p.anomalies.slice(0, 100)) list.appendChild(el('div', { text: a }));
      body.appendChild(list);
      body.appendChild(el('p', { class: 'sub', text: '这些格子按原表医生姓名导入，导出时诊室名仍用该医生自己的诊室。' }));
    }
    if (p.warnings && p.warnings.length) {
      const list = el('div', { class: 'issue-list' });
      for (const w of p.warnings) list.appendChild(el('div', { text: w }));
      body.appendChild(list);
    }

    body.appendChild(
      el('p', {
        class: 'sub',
        text: '导入会覆盖该月份已有的排班；医生字典里同名的会复用，只把缺的编号和号别留空等你在「医生资料」里补。',
      })
    );
    $('#btnImportConfirm').disabled = false;
  },

  async confirm() {
    if (!this.file) return;
    const btn = $('#btnImportConfirm');
    btn.disabled = true;
    btn.textContent = '正在导入…';
    try {
      const res = await call(window.api.legacy.apply, this.file);
      Modals.close('modalImport');
      await App.load();
      await App.loadMonth(res.ym);
      DoctorsView.render();
      RoomsView.draft = null;
      RoomsView.render();
      SettingsView.render();
      ScheduleView.render();
      toast(`已导入 ${res.ym}：${res.filled} 个班次，${res.rooms} 个诊室`, 'ok');
      if (res.anomalies && res.anomalies.length) {
        toast(`有 ${res.anomalies.length} 处跨诊室替班，已按原表医生导入`, 'warn');
      }
    } catch (err) {
      toast(`导入失败：${err.message}`, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '确认导入';
    }
  },
};

/* ---------------- 导出 ---------------- */
const ExportFlow = {
  dir: '',
  fileName: '',

  async open() {
    if (!App.month) {
      toast('还没加载月份数据', 'err');
      return;
    }
    await this.renderPreview();
  },

  /** 重新打开并试算（不动已经选好的导出位置） */
  async renderPreview() {
    const paths = App.snapshot.paths;
    if (!this.dir) this.dir = paths.exportDir;
    Modals.open('modalExport');
    const body = clear($('#exportBody'));
    body.appendChild(el('div', { class: 'loading', text: '正在试算导出结果…' }));
    let result;
    try {
      result = await call(window.api.exportMonth, App.ym, { dryRun: true });
    } catch (err) {
      clear(body).appendChild(el('div', { class: 'warn-item error', text: `试算失败：${err.message}` }));
      $('#btnExportConfirm').disabled = true;
      return;
    }
    if (!this.fileName) this.fileName = result.defaultFileName || `号源排班-${App.ym}.xlsx`;
    $('#btnExportConfirm').disabled = false;
    body.appendChild(this.destBlock());
    body.appendChild(this.infoBlock(result));
  },

  /** 导出到哪：文件夹 + 文件名，每次导出前自己确认一遍 */
  destBlock() {
    const wrap = el('div', { class: 'dest-block' });
    wrap.appendChild(el('h4', { text: '导出到' }));
    const row = el('div', { class: 'dest-row' }, [
      el('input', { class: 'input grow-input', value: this.dir, readonly: true, title: this.dir }),
      el('button', {
        class: 'btn btn-ghost',
        text: '选择文件夹…',
        onclick: () => this.chooseDir(),
      }),
    ]);
    wrap.appendChild(row);
    const nameRow = el('div', { class: 'dest-row' }, [
      el('span', { class: 'lbl', text: '文件名' }),
      el('input', {
        class: 'input grow-input',
        value: this.fileName,
        oninput: (event) => {
          this.fileName = event.target.value;
          this.updateDestPreview();
        },
      }),
    ]);
    wrap.appendChild(nameRow);
    this._preview = el('div', { class: 'dest-preview' });
    wrap.appendChild(this._preview);
    setTimeout(() => this.updateDestPreview(), 0);
    return wrap;
  },

  updateDestPreview() {
    if (!this._preview) return;
    const name = (this.fileName || '').trim() || '(还没填文件名)';
    clear(this._preview).appendChild(
      el('span', null, ['将保存为：', el('code', { text: `${this.dir}\\${name}` })])
    );
  },

  async chooseDir() {
    try {
      const picked = await call(window.api.pickFolder, this.dir);
      if (!picked) return;
      this.dir = picked;
      const input = $('#exportBody .dest-row .grow-input');
      if (input) input.value = picked;
      this.updateDestPreview();
    } catch (err) {
      toast(`选择文件夹失败：${err.message}`, 'err');
    }
  },

  infoBlock(result) {
    const wrap = el('div');
    const kv = el('dl', { class: 'kv' });
    const row = (k, v) => {
      kv.appendChild(el('dt', { text: k }));
      kv.appendChild(el('dd', { text: v }));
    };
    row('导出月份', `${App.ym}`);
    row('数据行数', `${result.rowCount} 行（覆盖 ${result.dayCount} 天）`);
    row('输出位置', App.snapshot.paths.exportDir);
    row('模板', result.templateUsed ? `${App.snapshot.paths.template}（样式沿用）` : '没找到模板，将用默认结构');
    wrap.appendChild(kv);

    const mapping = el('table', { class: 'mapping' });
    mapping.appendChild(
      el('tr', null, [
        el('th', { text: '模板列' }),
        el('th', { text: '来源' }),
        el('th', { text: '示例' }),
      ])
    );
    const samples = result.rows && result.rows.length ? result.rows : [];
    const s0 = samples[0] || {};
    const rows = [
      ['号源日期', '排班表里的日期', s0.date || ''],
      ['班次', '上午 / 下午', s0.shift || ''],
      ['班次开始时间', '日期 + 科室设置里的开始时间', s0.start || ''],
      ['班次结束时间', '日期 + 科室设置里的结束时间', s0.end || ''],
      ['机构名称', '科室设置', s0.orgName || '（空）'],
      ['坐诊科室名称', '科室设置', s0.deptName || ''],
      ['坐诊医生编码', '医生资料的「门诊编号」', s0.code || '（空）'],
      ['号别名称', '医生资料的「号别名称」', s0.title || '（空）'],
      ['诊室名称', '排班格子所在诊室的名称', s0.room || ''],
      ['分诊台名称', '科室设置', s0.triageDesk || ''],
    ];
    for (const [a, b, c] of rows) {
      mapping.appendChild(
        el('tr', { class: b.includes('医生资料') ? 'hl' : '' }, [
          el('td', { text: a }),
          el('td', { text: b }),
          el('td', { class: 'sample', text: c }),
        ])
      );
    }
    wrap.appendChild(el('h4', { text: '列对应关系' }));
    wrap.appendChild(mapping);
    wrap.appendChild(
      el('p', {
        class: 'sub',
        text: '没排班的格子不会出现在导出的表里，和模板已填的那几天规则一致。导出只会新建文件，不会改你原来的表。',
      })
    );

    if (result.problems && result.problems.length) {
      wrap.appendChild(el('h4', { text: `需要留意（${result.problems.length} 条）` }));
      const list = el('div', { class: 'issue-list' });
      for (const p of result.problems.slice(0, 120)) list.appendChild(el('div', { text: p }));
      wrap.appendChild(list);
    }
    if (result.notice) {
      wrap.appendChild(el('p', { class: 'warn-item', text: result.notice }));
    }
    return wrap;
  },

  async confirm() {
    const btn = $('#btnExportConfirm');
    btn.disabled = true;
    btn.textContent = '正在导出…';
    try {
      // 导出前把还在防抖里的医生资料改动和排班改动都落盘，避免导出的还是旧数据
      await DoctorsView.flushPending();
      await App.saveNow(true);
      const name = (this.fileName || '').trim() || `号源排班-${App.ym}.xlsx`;
      const outFile = this.dir ? `${this.dir.replace(/[\\/]+$/, '')}\\${name}` : '';
      const result = await call(window.api.exportMonth, App.ym, { outDir: this.dir, outFile });
      Modals.close('modalExport');
      App.lastExport = result.file;
      toast(`已导出 ${result.rowCount} 行：${result.file}`, 'ok');
      this.showDone(result);
    } catch (err) {
      toast(`导出失败：${err.message}`, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '导出到 Excel';
    }
  },

  showDone(result) {
    Modals.open('modalExport');
    const body = clear($('#exportBody'));
    body.appendChild(
      el('div', { class: 'help-sec' }, [
        el('h4', { text: '导出完成' }),
        el('p', { text: result.file }),
        el('div', null, [
          el('button', { class: 'btn btn-primary', text: '打开文件', onclick: () => window.api.openFile(result.file) }),
          el('span', { text: ' ' }),
          el('button', {
            class: 'btn btn-ghost',
            text: '打开所在文件夹',
            onclick: () => window.api.reveal(result.file),
          }),
          el('span', { text: ' ' }),
          el('button', {
            class: 'btn btn-ghost',
            text: '再导一次',
            onclick: () => this.renderPreview(),
          }),
        ]),
      ])
    );
    body.appendChild(this.infoBlock(result));
  },
};

/* ---------------- 说明 ---------------- */
const Help = {
  show(kind) {
    Modals.open('modalHelp');
    if (kind === 'columns') return this.renderColumns();
    return this.renderGuide();
  },

  renderGuide() {
    $('#helpTitle').textContent = '使用说明';
    const body = clear($('#helpBody'));
    const sec = (title, items) => {
      body.appendChild(
        el('div', { class: 'help-sec' }, [el('h4', { text: title }), el('ul', null, items.map((t) => el('li', { html: t })))])
      );
    };
    sec('三步走', [
      '在「医生资料」里填好每位医生的 <b>姓名 / 门诊编号 / 号别名称 / 默认诊室</b>，改完自动保存。',
      '回到「排班表」，在<b>下面一排</b>点一位医生选中，再点格子或按住鼠标拖动，就能连续排班。',
      '排完点右上角 <b>导出排班表</b>，自己选一个文件夹，导出的文件按模板格式排版。',
    ]);
    sec('排班表怎么点', [
      '<b>选中医生</b>：在排班表下面一排的「排班医生」里点名字，顶部会显示当前画笔。',
      '<b>排一格</b>：点空格子即填入当前医生。',
      '<b>连续排</b>：按住鼠标左键拖动，划过的格子都会排上。',
      '<b>取消</b>：对同一个医生连点，会把该格清空（相当于橡皮擦）。',
      '<b>右键菜单</b>：清空单格、清空整行、清空整列、整行都排同一位医生。',
      '<b>仅选择模式</b>：只想看看某个格子，不想误改时切到「仅选择」。',
    ]);
    sec('快捷键', [
      '<kbd>Ctrl</kbd>+<kbd>Z</kbd> 撤销，<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> 重做。',
      '<kbd>Ctrl</kbd>+<kbd>S</kbd> 保存，<kbd>Ctrl</kbd>+<kbd>E</kbd> 导出排班表。',
      '<kbd>Esc</kbd> 取消当前选中的医生。',
    ]);
    sec('数据放在哪', [
      `医生和排班数据都在 <code>data/</code> 文件夹（两个 json 文件），备份这个文件夹就等于备份了全部数据。`,
      '导出的表只新建文件，不改动你原来的排班表和模板。',
      '界面上的改动会自动保存，顶栏会显示「有改动未保存」。',
    ]);
  },

  renderColumns() {
    $('#helpTitle').textContent = '导出列对照说明';
    const body = clear($('#helpBody'));
    body.appendChild(
      el('p', {
        class: 'sub',
        text: '导出表严格按「门诊排班模板.xlsx」的 号源排班 sheet：第 1 行表头，第 2 行起一条班次一行。',
      })
    );
    const map = el('table', { class: 'mapping' });
    map.appendChild(el('tr', null, [el('th', { text: '模板列' }), el('th', { text: '来源' }), el('th', { text: '示例' })]));
    const rows = [
      ['号源日期', '排班表日期', '2026-10-23'],
      ['班次', '上午 / 下午', '上午'],
      ['班次开始时间', '日期 + 开始时间', '2026-10-23 08:00:00'],
      ['班次结束时间', '日期 + 结束时间', '2026-10-23 12:00:00'],
      ['机构名称', '科室设置', '（可留空）'],
      ['坐诊科室名称', '科室设置', '（自己填）'],
      ['坐诊医生编码', '医生资料 · 门诊编号', 'doctor001'],
      ['号别名称', '医生资料 · 号别名称', '医师'],
      ['诊室名称', '诊室设置 · 诊室名称', '门诊诊室1'],
      ['分诊台名称', '科室设置', '（自己填）'],
    ];
    for (const [a, b, c] of rows) {
      map.appendChild(el('tr', null, [el('td', { text: a }), el('td', { text: b }), el('td', { class: 'sample', text: c })]));
    }
    body.appendChild(map);
    body.appendChild(
      el('div', { class: 'help-sec' }, [
        el('h4', { text: '排列顺序' }),
        el('ul', null, [
          el('li', { text: '先按日期从早到晚；' }),
          el('li', { text: '同一天先上午后下午；' }),
          el('li', { text: '同一班次按「诊室设置」里的顺序，从左到右。' }),
        ]),
      ])
    );
  },
};

document.addEventListener('DOMContentLoaded', () => {
  $('#btnImport').onclick = () => ImportFlow.start();
  $('#btnImportConfirm').onclick = () => ImportFlow.confirm();
  $('#btnExport').onclick = () => ExportFlow.open();
  $('#btnExportConfirm').onclick = () => ExportFlow.confirm();
  $('#btnHelp').onclick = () => Help.show();
  for (const btn of $$('[data-close]')) {
    btn.onclick = () => Modals.close(btn.dataset.close);
  }
  for (const modal of $$('.modal')) {
    modal.onmousedown = (event) => {
      if (event.target === modal) modal.hidden = true;
    };
  }
});
