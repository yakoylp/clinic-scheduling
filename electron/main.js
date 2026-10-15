'use strict';
/**
 * Electron 主进程：单窗口应用，本地离线，不联网。
 *
 * 注意：下面这段「定用户数据目录」的代码必须放在最前面，且只依赖 electron / path / fs。
 * app.setPath('userData') 越早调用越可靠——便携版（Portable exe）尤其挑时机：
 * 放在 ready 之后再调，Electron 已经按 package.json 的 name 建过一次目录了，
 * 数据就会落到 %APPDATA%/<package name> 去，跟着 exe 名字走、换个版本就找不着。
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_NAME = '门诊排班';
/** 历史上用过的目录名，从新到旧；升上来时按顺序找第一个有数据的搬过来 */
const LEGACY_APP_NAMES = ['clinic-scheduling', 'derm-scheduling'];

(function pinUserDataDir() {
  try {
    const appData = app.getPath('appData');
    const target = path.join(appData, APP_NAME);
    const targetData = path.join(target, 'data');
    for (const legacyName of LEGACY_APP_NAMES) {
      const legacy = path.join(appData, legacyName, 'data');
      if (!fs.existsSync(targetData) && fs.existsSync(legacy)) {
        fs.mkdirSync(path.dirname(targetData), { recursive: true });
        fs.cpSync(legacy, targetData, { recursive: true });
        console.log(`[paths] 已把数据从 ${legacyName} 迁移到 ${APP_NAME}`);
      }
    }
    app.setName(APP_NAME);
    app.setPath('userData', target);
    console.log(`[paths] 用户数据目录 = ${target}`);
  } catch (err) {
    // 取不到路径也不该让软件起不来，退回 Electron 默认值
    console.log(`[paths] 设定用户数据目录失败，改用默认值：${err.message}`);
  }
})();

const { BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const api = require('./api');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');
const ICON = path.join(__dirname, '..', 'public', 'assets', 'icon.png');

/**
 * 冒烟测试用：设置 DSH_SMOKE=截图路径 时，启动后自动截图并退出，同时把渲染进程的
 * 报错打到 stdout。正常使用不会走到这里。
 */
const SMOKE = process.env.DSH_SMOKE || '';

let win = null;
let dirty = false;
let forceClose = false;

function setupSmokeHooks(browserWindow) {
  browserWindow.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.log(`[renderer:${level}] ${message} (${source}:${line})`);
  });
  browserWindow.webContents.on('render-process-gone', (_e, details) => {
    console.log(`[renderer-gone] ${JSON.stringify(details)}`);
  });
  browserWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.log(`[load-failed] ${code} ${desc}`);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    title: APP_NAME,
    backgroundColor: '#f5f7fa',
    show: false,
    autoHideMenuBar: true,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadFile(INDEX);
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  if (SMOKE) setupSmokeHooks(win);

  win.on('close', (event) => {
    if (dirty && !forceClose) {
      event.preventDefault();
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['先保存再关闭', '不保存，直接关闭', '取消'],
        defaultId: 0,
        cancelId: 2,
        title: '还有改动没有保存',
        message: '当前月份的排班有改动还没保存到本地，确定要关闭吗？',
      });
      if (choice === 2) return;
      if (choice === 0) {
        win.webContents.send('app:save-before-close');
        const timer = setInterval(() => {
          if (!dirty || forceClose) {
            clearInterval(timer);
            forceClose = true;
            win.close();
          }
        }, 200);
        return;
      }
      forceClose = true;
      win.close();
    }
  });

  win.on('closed', () => {
    win = null;
  });

  // 外链一律用系统浏览器打开，不在应用内跳转
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '导入旧排班表…',
          accelerator: 'CmdOrCtrl+I',
          click: () => win && win.webContents.send('menu:import'),
        },
        {
          label: '导出本月的号源排班表',
          accelerator: 'CmdOrCtrl+E',
          click: () => win && win.webContents.send('menu:export'),
        },
        { type: 'separator' },
        {
          label: '打开导出文件夹',
          click: () => {
            fs.mkdirSync(api.snapshot().paths.exportDir, { recursive: true });
            shell.openPath(api.snapshot().paths.exportDir);
          },
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: () => win && win.webContents.send('menu:undo') },
        { label: '重做', accelerator: 'CmdOrCtrl+Shift+Z', click: () => win && win.webContents.send('menu:redo') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => win && win.webContents.send('menu:save') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '排班表', click: () => win && win.webContents.send('menu:tab', 'schedule') },
        { label: '医生资料', click: () => win && win.webContents.send('menu:tab', 'doctors') },
        { label: '诊室设置', click: () => win && win.webContents.send('menu:tab', 'rooms') },
        { label: '科室设置', click: () => win && win.webContents.send('menu:tab', 'settings') },
        { type: 'separator' },
        { role: 'reload', label: '刷新界面' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '恢复缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '使用说明',
          click: () => win && win.webContents.send('menu:help'),
        },
        {
          label: '导出列对照说明',
          click: () => win && win.webContents.send('menu:help-columns'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  api.register(ipcMain);
  api.setDirtyListener((value) => {
    dirty = value;
    if (win) win.setTitle(`${value ? '● ' : ''}${APP_NAME}`);
  });
  createWindow();
  if (!SMOKE) buildMenu();

  if (SMOKE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          // 截图前可以先驱动一下界面（冒烟测试用，例如切到某个页面）
          if (process.env.DSH_SMOKE_SCRIPT) {
            await win.webContents.executeJavaScript(process.env.DSH_SMOKE_SCRIPT);
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          const image = await win.webContents.capturePage();
          fs.writeFileSync(SMOKE, image.toPNG());
          console.log(`[smoke] 截图已保存 ${SMOKE}`);
          console.log(`[smoke] 标题: ${win.getTitle()}`);
          const diag = await win.webContents.executeJavaScript(
            `(() => {
              const m = App.month || {};
              const slots = m.slots || {};
              const values = Object.values(slots);
              return JSON.stringify({
                ym: App.ym,
                months: App.snapshot.months,
                filledMonths: App.snapshot.filledMonths,
                dataDir: App.snapshot.paths.data,
                doctors: App.snapshot.doctors.length,
                slotKeys: Object.keys(slots).length,
                nonEmpty: values.filter(Boolean).length,
                statsFilled: App.stats ? App.stats.filled : null,
                paletteChips: document.querySelectorAll('#palette .doc-chip').length,
                activeChip: document.querySelectorAll('#palette .doc-chip.active').length,
              });
            })()`
          );
          console.log(`[smoke] 界面状态: ${diag}`);
        } catch (err) {
          console.log(`[smoke] 截图失败: ${err.message}`);
        }
        setTimeout(() => {
          forceClose = true;
          dirty = false;
          app.exit(0);
        }, 200);
      }, 1800);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (err) => {
  const message = err && err.stack ? err.stack : String(err);
  try {
    fs.appendFileSync(path.join(__dirname, '..', 'data', 'error.log'), `${new Date().toISOString()} ${message}\n\n`);
  } catch (e) {
    /* 日志写不进去也不能让进程挂在异常里 */
  }
  if (win) {
    dialog.showErrorBox('程序出错', `${err && err.message ? err.message : err}\n\n详情已写入 data/error.log`);
  }
});
