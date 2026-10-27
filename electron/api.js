'use strict';
/**
 * Electron 侧：把纯业务逻辑注册成 IPC，并处理窗口/文件对话框。
 * 业务逻辑本身在 lib/handlers.js（不依赖 Electron，可单独测试）。
 */
const fs = require('fs');
const path = require('path');
const handlers = require('../lib/handlers');
const paths = require('../lib/paths');

let win = null;
let onDirty = () => {};

function attachWindow(browserWindow) {
  win = browserWindow;
}

function setDirtyListener(fn) {
  onDirty = typeof fn === 'function' ? fn : () => {};
}

function wrap(handler) {
  return async (_event, ...args) => {
    try {
      const data = await handler(...args);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  };
}

/** 弹出系统文件选择框，挑一个 Excel */
async function pickExcel(defaultPath) {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(win || undefined, {
    title: '选择要导入的排班表',
    defaultPath: defaultPath || paths.ROOT,
    filters: [{ name: 'Excel 工作簿', extensions: ['xlsx', 'xlsm', 'xls'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

/** 弹出系统文件夹选择框（导出时用户自己指定位置） */
async function pickFolder(defaultPath) {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(win || undefined, {
    title: '选择导出的文件夹',
    defaultPath: defaultPath || paths.resolveExportDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

async function revealFile(file) {
  if (!file || !fs.existsSync(file)) throw new Error('文件不存在');
  const { shell } = require('electron');
  shell.showItemInFolder(file);
  return true;
}

async function openFile(file) {
  if (!file || !fs.existsSync(file)) throw new Error('文件不存在');
  const { shell } = require('electron');
  const err = await shell.openPath(file);
  if (err) throw new Error(err);
  return true;
}

async function openFolder(dir) {
  const target = dir || paths.resolveExportDir();
  fs.mkdirSync(target, { recursive: true });
  const { shell } = require('electron');
  const err = await shell.openPath(target);
  if (err) throw new Error(err);
  return true;
}

/**
 * 把界面画好的排班视图长图写进系统剪贴板。
 * 界面传过来的是 PNG 的 dataURL（比传二进制更省事，也不受 IPC 序列化差异影响）。
 */
async function copyImageToClipboard(dataUrl) {
  const { clipboard, nativeImage } = require('electron');
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    throw new Error('图片数据格式不对');
  }
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) throw new Error('生成的图片是空的');
  clipboard.writeImage(image);
  // 冒烟测试用：把同一张图落盘，方便核对长图内容（正常使用不会触发）
  if (process.env.DSH_CLIPBOARD_PNG) {
    try {
      fs.writeFileSync(process.env.DSH_CLIPBOARD_PNG, image.toPNG());
    } catch (err) {
      /* 落盘失败不影响复制 */
    }
  }
  const back = clipboard.readImage();
  return {
    width: image.getSize().width,
    height: image.getSize().height,
    clipboardWidth: back.getSize().width,
    clipboardHeight: back.getSize().height,
  };
}

const CHANNELS = [
  ['app:snapshot', () => handlers.snapshot()],
  ['clipboard:image', (dataUrl) => copyImageToClipboard(dataUrl)],
  ['month:get', (ym) => handlers.getMonth(ym)],
  ['month:patch', (ym, changes) => handlers.patchMonth(ym, changes)],
  ['month:setSlotTime', (ym, date, shift, roomId, times) => handlers.setSlotTime(ym, date, shift, roomId, times)],
  ['month:clearSlotTime', (ym, date, shift, roomId) => handlers.clearSlotTime(ym, date, shift, roomId)],
  ['month:create', (ym) => handlers.createMonth(ym)],
  ['month:clear', (ym, scope) => handlers.clearMonth(ym, scope)],
  ['month:delete', (ym) => handlers.deleteMonth(ym)],
  ['month:range', (ym, s, e) => handlers.setMonthRange(ym, s, e)],
  ['doctors:save', (doctors) => handlers.saveDoctors(doctors)],
  ['rooms:save', (rooms) => handlers.saveRooms(rooms)],
  ['settings:save', (settings) => handlers.saveSettings(settings)],
  ['legacy:pick', (defaultPath) => pickExcel(defaultPath)],
  ['legacy:preview', (file) => handlers.previewLegacy(file)],
  ['legacy:apply', (file) => handlers.applyLegacy(file)],
  ['dialog:pickFolder', (defaultPath) => pickFolder(defaultPath)],
  ['export:month', (ym, options) => handlers.exportMonth(ym, options)],
  ['shell:reveal', (file) => revealFile(file)],
  ['shell:open', (file) => openFile(file)],
  ['shell:openFolder', (dir) => openFolder(dir)],
];

const EXPORTED_HANDLERS = [];
void EXPORTED_HANDLERS;

function register(ipcMain) {
  for (const [channel, handler] of CHANNELS) ipcMain.handle(channel, wrap(handler));
  ipcMain.handle('window:dirty', (_e, dirty) => {
    onDirty(!!dirty);
    return { ok: true };
  });
}

module.exports = Object.assign({}, handlers, {
  attachWindow,
  setDirtyListener,
  register,
  pickExcel,
  pickFolder,
  revealFile,
  openFile,
  openFolder,
  CHANNELS,
});
