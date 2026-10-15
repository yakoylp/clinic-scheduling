'use strict';
/**
 * 预加载脚本：只把需要的接口暴露给界面，界面拿不到 Node 能力。
 */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  snapshot: () => invoke('app:snapshot'),

  month: {
    get: (ym) => invoke('month:get', ym),
    patch: (ym, changes) => invoke('month:patch', ym, changes),
    setSlotTime: (ym, date, shift, roomId, times) => invoke('month:setSlotTime', ym, date, shift, roomId, times),
    clearSlotTime: (ym, date, shift, roomId) => invoke('month:clearSlotTime', ym, date, shift, roomId),
    create: (ym) => invoke('month:create', ym),
    clear: (ym, scope) => invoke('month:clear', ym, scope),
    remove: (ym) => invoke('month:delete', ym),
    range: (ym, start, end) => invoke('month:range', ym, start, end),
  },

  doctors: {
    save: (doctors) => invoke('doctors:save', doctors),
  },

  rooms: {
    save: (rooms) => invoke('rooms:save', rooms),
  },

  settings: {
    save: (settings) => invoke('settings:save', settings),
  },

  legacy: {
    pick: (defaultPath) => invoke('legacy:pick', defaultPath),
    preview: (file) => invoke('legacy:preview', file),
    apply: (file) => invoke('legacy:apply', file),
  },

  exportMonth: (ym, options) => invoke('export:month', ym, options),
  pickFolder: (defaultPath) => invoke('dialog:pickFolder', defaultPath),
  reveal: (file) => invoke('shell:reveal', file),
  openFile: (file) => invoke('shell:open', file),
  openFolder: (dir) => invoke('shell:openFolder', dir),
  setDirty: (dirty) => ipcRenderer.send('window:dirty', dirty),

  onMenu: (channel, handler) => {
    const allowed = [
      'menu:import',
      'menu:export',
      'menu:undo',
      'menu:redo',
      'menu:save',
      'menu:tab',
      'menu:help',
      'menu:help-columns',
      'app:save-before-close',
    ];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => handler(payload));
  },
});
