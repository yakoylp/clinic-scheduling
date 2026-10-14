'use strict';
/**
 * 路径解析。
 *
 * 源码方式运行（双击「启动排班软件.bat」）时，数据、模板、导出都放在项目目录里，
 * 换台电脑把文件夹拷过去就能用。
 *
 * 打包成 exe 之后，代码被塞进只读的 app.asar，不能再往那里面写东西了，于是：
 *   - 数据目录：%APPDATA%/门诊排班/
 *   - 导出目录：exe 同级目录（绿色版，用户容易找到）；同级写不进去才退回数据目录下的 导出/
 *   - 模板：包内那份只读模板
 *
 * 环境变量优先级最高，自动化测试都靠它们：
 *   DSH_SCHEDULE_DATA / DSH_SCHEDULE_TEMPLATE / DSH_SCHEDULE_OUT
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IN_ASAR = __dirname.includes('app.asar');
/**
 * 是不是打包后运行。
 * 判断依据只能是「代码是否在 app.asar 里」：开发模式下 Electron 同样会设置
 * process.resourcesPath，用它判断会把源码运行误判成打包版，跑去 %APPDATA% 找数据。
 */
const PACKAGED = IN_ASAR;

/** 数据目录的最终位置 */
function resolveDataDir() {
  if (process.env.DSH_SCHEDULE_DATA) return path.resolve(process.env.DSH_SCHEDULE_DATA);
  if (!PACKAGED) return path.join(ROOT, 'data');
  return path.join(userDataDir(), 'data');
}

function resolveTemplate() {
  if (process.env.DSH_SCHEDULE_TEMPLATE) return path.resolve(process.env.DSH_SCHEDULE_TEMPLATE);
  return path.join(ROOT, '门诊排班模板.xlsx');
}

/** exe 同级目录（便携版绿色目录） */
function exeDir() {
  const exe = process.execPath || '';
  // 便携版会解压到临时目录再跑，临时目录不适合当长期数据位置
  if (!exe || /\\Temp\\/i.test(exe) || /\\Windows\\/i.test(exe)) return null;
  return path.dirname(exe);
}

function userDataDir() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch (err) {
    /* 不在 Electron 里（比如跑单元测试）就用下面的兜底 */
  }
  const base = process.env.APPDATA || process.env.HOME || process.cwd();
  return path.join(base, '门诊排班');
}

function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (err) {
    return false;
  }
}

/** 导出目录：优先 exe 同级，写不进去就用数据目录下的 导出/ */
function resolveExportDir() {
  if (process.env.DSH_SCHEDULE_OUT) return path.resolve(process.env.DSH_SCHEDULE_OUT);
  if (!PACKAGED) return path.join(ROOT, '导出');
  const beside = exeDir();
  if (beside && isWritable(beside)) return path.join(beside, '导出');
  return path.join(resolveDataDir(), '导出');
}

/** 界面「打开数据目录」用得到 */
function describe() {
  return {
    root: ROOT,
    packaged: PACKAGED,
    data: resolveDataDir(),
    exportDir: resolveExportDir(),
    template: resolveTemplate(),
  };
}

module.exports = {
  ROOT,
  PACKAGED,
  IN_ASAR,
  resolveDataDir,
  resolveTemplate,
  resolveExportDir,
  userDataDir,
  describe,
};
