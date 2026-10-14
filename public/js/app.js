'use strict';
/** 应用装配：标签页、月份切换、快捷键、事件绑定、启动流程 */

const TABS = ['schedule', 'doctors', 'rooms', 'settings'];
let activeTab = 'schedule';

function switchTab(tab) {
  if (!TABS.includes(tab)) return;
  activeTab = tab;
  for (const t of $$('#tabs .tab')) t.classList.toggle('active', t.dataset.tab === tab);
  for (const p of $$('.page')) p.classList.toggle('active', p.id === `page-${tab}`);
  if (tab === 'doctors') DoctorsView.render();
  if (tab === 'rooms') RoomsView.render();
  if (tab === 'settings') SettingsView.render();
  if (tab === 'schedule') {
    ScheduleView.render();
    ScheduleView.renderSelected();
  }
}

/* ---------------- 月份切换 ---------------- */
function fillMonthSelectors() {
  const yearSel = $('#selYear');
  const monthSel = $('#selMonth');
  const now = new Date();
  clear(yearSel);
  for (let y = now.getFullYear() - 2; y <= now.getFullYear() + 3; y += 1) {
    yearSel.appendChild(el('option', { value: y, text: y }));
  }
  clear(monthSel);
  for (let m = 1; m <= 12; m += 1) monthSel.appendChild(el('option', { value: m, text: m }));

  const used = (App.snapshot.months || []).map((ym) => ym.split('-').map(Number));
  for (const [y, m] of used) {
    if (!$$('#selYear option').some((o) => Number(o.value) === y)) {
      yearSel.appendChild(el('option', { value: y, text: y }));
    }
  }
}

function syncMonthSelectors() {
  if (!App.ym) return;
  const [y, m] = App.ym.split('-').map(Number);
  const yearSel = $('#selYear');
  if (!$$('option', yearSel).some((o) => Number(o.value) === y)) {
    yearSel.appendChild(el('option', { value: y, text: y }));
  }
  yearSel.value = String(y);
  $('#selMonth').value = String(m);
}

async function gotoMonth(ym) {
  if (ym === App.ym) return;
  if (App.dirty) await App.saveNow(true);
  await App.loadMonth(ym);
  syncMonthSelectors();
  ScheduleView.render();
  ScheduleView.renderBrush();
  ScheduleView.syncModeUi();
  updateStatus();
}

function stepMonth(delta) {
  if (!App.ym) return;
  const [y, m] = App.ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return gotoMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
}

/* ---------------- 顶栏状态 ---------------- */
function updateStatus() {
  const node = $('#saveStatus');
  if (App.saving) {
    node.textContent = '正在保存…';
    node.classList.remove('dirty');
    return;
  }
  if (App.dirty) {
    node.textContent = '有改动未保存';
    node.classList.add('dirty');
  } else {
    node.textContent = '已保存';
    node.classList.remove('dirty');
  }
  $('#btnUndo').disabled = !App.canUndo;
  $('#btnRedo').disabled = !App.canRedo;
}

/* ---------------- 启动 ---------------- */
async function boot() {
  try {
    await App.load();
    fillMonthSelectors();
    const months = App.snapshot.months || [];
    const ym = App.defaultMonth();
    App.ym = ym;
    await App.loadMonth(ym);
    syncMonthSelectors();

    RoomsView.draft = null;
    SettingsView.render();
    DoctorsView.render();
    ScheduleView.render();
    ScheduleView.renderBrush();
    ScheduleView.syncModeUi();
    updateStatus();
    App.startAutoSave();

    App.on((evt) => {
      if (evt.type === 'brush') {
        ScheduleView.renderBrush();
        ScheduleView.renderPalette();
      }
      if (evt.type === 'mode') ScheduleView.syncModeUi();
      if (evt.type === 'selection') ScheduleView.renderSelected();
      if (evt.type === 'dirty' || evt.type === 'saved') updateStatus();
      if (evt.type === 'slots') updateStatus();
    });

    window.addEventListener('resize', () => ScheduleView.syncHeader());

    // 真正的首次启动：没有医生、也没有任何排班，才主动弹一次说明
    const fresh =
      (App.snapshot.doctors || []).length === 0 &&
      (App.snapshot.months || []).length === 0 &&
      (App.snapshot.filledMonths || []).length === 0;
    if (fresh) setTimeout(() => Help.show(), 400);
  } catch (err) {
    document.body.innerHTML = `<div style="padding:40px;font-family:inherit">
      <h2>启动失败</h2><p>${err.message}</p>
      <p>请把 data/error.log 一起发给开发人员。</p></div>`;
  }
}

/* ---------------- 事件绑定 ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  for (const tab of $$('#tabs .tab')) tab.onclick = () => switchTab(tab.dataset.tab);
  for (const seg of $$('#modeSwitch .seg')) seg.onclick = () => App.setMode(seg.dataset.mode);

  $('#selYear').onchange = () => gotoMonth(`${$('#selYear').value}-${pad2($('#selMonth').value)}`);
  $('#selMonth').onchange = () => gotoMonth(`${$('#selYear').value}-${pad2($('#selMonth').value)}`);
  $('#btnPrevMonth').onclick = () => stepMonth(-1);
  $('#btnNextMonth').onclick = () => stepMonth(1);

  $('#btnSave').onclick = () => App.saveNow(false);
  $('#btnUndo').onclick = () => {
    if (App.undo()) {
      ScheduleView.render();
      updateStatus();
    }
  };
  $('#btnRedo').onclick = () => {
    if (App.redo()) {
      ScheduleView.render();
      updateStatus();
    }
  };
  $('#btnClearMonth').onclick = () => {
    const filled = App.stats ? App.stats.filled : 0;
    if (!filled) {
      toast('本月还没有排班', 'ok');
      return;
    }
    if (!window.confirm(`确定清空 ${App.ym} 的全部 ${filled} 个已排班次吗？可以用 Ctrl+Z 撤销。`)) return;
    ScheduleView.clearScope({});
  };

  document.addEventListener('keydown', (event) => {
    const meta = event.ctrlKey || event.metaKey;
    if (!meta) {
      if (event.key === 'Escape') {
        if ($$('.modal:not([hidden])').length) Modals.closeAll();
        else if (App.brushId) {
          App.brushId = null;
          App.emit({ type: 'brush' });
        }
      }
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      if (App.undo()) {
        ScheduleView.render();
        updateStatus();
      }
    } else if ((key === 'z' && event.shiftKey) || key === 'y') {
      event.preventDefault();
      if (App.redo()) {
        ScheduleView.render();
        updateStatus();
      }
    } else if (key === 's') {
      event.preventDefault();
      App.saveNow(false);
    } else if (key === 'e') {
      event.preventDefault();
      ExportFlow.open();
    } else if (key === 'i') {
      event.preventDefault();
      ImportFlow.start();
    }
  });

  window.api.onMenu('menu:import', () => ImportFlow.start());
  window.api.onMenu('menu:export', () => ExportFlow.open());
  window.api.onMenu('menu:save', () => App.saveNow(false));
  window.api.onMenu('menu:undo', () => {
    if (App.undo()) {
      ScheduleView.render();
      updateStatus();
    }
  });
  window.api.onMenu('menu:redo', () => {
    if (App.redo()) {
      ScheduleView.render();
      updateStatus();
    }
  });
  window.api.onMenu('menu:tab', (tab) => switchTab(tab));
  window.api.onMenu('menu:help', () => Help.show());
  window.api.onMenu('menu:help-columns', () => Help.show('columns'));
  window.api.onMenu('app:save-before-close', async () => {
    try {
      await App.saveNow(true);
    } finally {
      window.api.setDirty(false);
    }
  });

  window.addEventListener('beforeunload', () => {
    if (App.dirty) App.saveNow(true);
  });

  boot();
});
