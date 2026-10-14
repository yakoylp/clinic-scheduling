'use strict';
/**
 * 导出引擎：把可视化排班结果按「门诊排班模板.xlsx」的列结构写成新的 xlsx。
 *
 * 列顺序（10 列，与模板 号源排班 sheet 完全一致）：
 *   号源日期 / 班次 / 班次开始时间 / 班次结束时间 / 机构名称 /
 *   坐诊科室名称 / 坐诊医生编码 / 号别名称 / 诊室名称 / 分诊台名称
 *
 * 规则：
 *   - 日期升序 → 上午在前下午在后 → 诊室按顺序号
 *   - 只导出真正安排了医生的格子（与模板已填部分一致：没排班的诊室不占行）
 *   - 医生编码为空时该格留空
 *   - 输出到 导出/ 子目录，绝不覆盖原始文件；同名自动加序号
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const XLSX = require('xlsx');
const store = require('./store');
const paths = require('./paths');

const ROOT = paths.ROOT;
const TEMPLATE_FILE = paths.resolveTemplate();
const EXPORT_DIR = paths.resolveExportDir();
const PY_WORKER = path.join(__dirname, '..', 'tools', 'xlsx_writer.py');
const BUNDLED_PY = path.join(
  paths.PACKAGED ? process.resourcesPath : path.join(ROOT, 'runtime'),
  'python',
  process.platform === 'win32' ? 'python.exe' : 'bin/python3'
);

// 兜底默认值：真实值来自「科室设置」（data/schedule.json 的 settings）
const DEFAULTS = {
  orgName: '',
  deptName: '',
  triageDesk: '',
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 班次起止时间：优先用排班数据里的 shiftTimes，否则按默认时刻现算 */
function shiftTime(month, date, shiftName, shifts) {
  const fromData = month && month.shiftTimes && month.shiftTimes[`${date}|${shiftName}`];
  if (fromData && fromData.start && fromData.end) return fromData;
  const conf = (shifts || store.DEFAULT_SHIFTS).find((s) => s.name === shiftName);
  const start = conf ? conf.start : shiftName === '上午' ? '08:00:00' : '14:30:00';
  const end = conf ? conf.end : shiftName === '上午' ? '12:00:00' : '17:30:00';
  return { start: `${date} ${start}`, end: `${date} ${end}` };
}

/**
 * 生成要导出的行。
 * @returns {Array<{date, shift, cells: string[]}>}
 */
function buildRows(roster, schedule, ym, options) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  const month = schedule.months[ym];
  if (!month) throw new Error(`没有 ${ym} 的排班数据，先排班再导出`);

  const doctors = new Map(roster.doctors.map((d) => [d.id, d]));
  const rooms = schedule.rooms
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  const shiftOrder = schedule.shifts.map((s) => s.name);

  // 该月实际有排班的日期
  const dates = [...new Set(Object.keys(month.slots).map((k) => k.split('|')[0]))].sort();
  const rows = [];
  const problems = [];

  for (const date of dates) {
    const shifts = shiftOrder.filter((s) => rooms.some((r) => month.slots[`${date}|${s}|${r.id}`]));
    const orderedShifts = shiftOrder.filter((s) => shifts.includes(s));
    for (const shift of orderedShifts) {
      const time = shiftTime(month, date, shift, schedule.shifts);
      for (const room of rooms) {
        const docId = month.slots[`${date}|${shift}|${room.id}`];
        if (!docId) continue;
        const doc = doctors.get(docId);
        if (!doc) {
          problems.push(`${date} ${shift} ${room.name} 指向了已删除的医生，已跳过`);
          continue;
        }
        if (!doc.code) problems.push(`${date} ${shift} ${doc.name} 没有填门诊编号，编码列会留空`);
        if (!doc.title) problems.push(`${date} ${shift} ${doc.name} 没有填号别名称，号别列会留空`);
        rows.push({
          date,
          shift,
          room: room.name,
          doctor: doc.name,
          start: time.start,
          end: time.end,
          cells: [
            date,
            shift,
            time.start,
            time.end,
            opts.orgName || '',
            opts.deptName || '',
            doc.code || '',
            doc.title || '',
            room.name || '',
            opts.triageDesk || '',
          ],
        });
      }
    }
  }
  return { rows, problems: [...new Set(problems)], month };
}

/** 组装成二维数组（含表头），导出/预览都用得上 */
function buildMatrix(rows) {
  return [store.EXPORT_COLUMNS.slice(), ...rows.map((r) => r.cells)];
}

/**
 * 找可用的 Python（带 openpyxl）。
 * 顺序：DSH_PYTHON 环境变量 → 随软件打包的 runtime/python → 本机 python / py。
 * 全都不能用时返回 null，导出会退回 SheetJS（样式会有损失，但数据正确）。
 */
let pythonCache;
function findPython() {
  if (pythonCache !== undefined) return pythonCache;
  const candidates = [];
  if (process.env.DSH_PYTHON) candidates.push(process.env.DSH_PYTHON);
  candidates.push(BUNDLED_PY);
  candidates.push('python', 'python3', 'py');

  for (const exe of candidates) {
    if (exe !== 'python' && exe !== 'python3' && exe !== 'py' && !fs.existsSync(exe)) continue;
    const probe = spawnSync(exe, ['-c', 'import openpyxl;print(openpyxl.__version__)'], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    });
    if (probe.status === 0 && /^\d/.test((probe.stdout || '').trim())) {
      pythonCache = exe;
      return exe;
    }
  }
  pythonCache = null;
  return null;
}

/** 用 openpyxl worker 写出（保留模板样式） */
function writeWithPython(python, wb, rows, outFile) {
  // Python 读不了 app.asar 里的文件，worker 和模板都要先复制到临时目录
  const workDir = path.join(os.tmpdir(), `derm-sched-${process.pid}`);
  fs.mkdirSync(workDir, { recursive: true });
  const workerCopy = path.join(workDir, 'xlsx_writer.py');
  fs.copyFileSync(PY_WORKER, workerCopy);

  let templateForPython = null;
  if (wb.templateUsed) {
    templateForPython = path.join(workDir, '模板.xlsx');
    fs.copyFileSync(TEMPLATE_FILE, templateForPython);
  }

  const job = {
    template: templateForPython,
    output: outFile,
    sheet: '号源排班',
    headers: store.EXPORT_COLUMNS.slice(),
    rows: rows.map((r) => r.cells),
    textColumns: [0, 1, 2, 3],
  };
  const jobFile = path.join(workDir, 'job.json');
  fs.writeFileSync(jobFile, JSON.stringify(job), 'utf8');
  try {
    const run = spawnSync(python, [workerCopy, jobFile], {
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
      cwd: workDir,
    });
    const out = `${run.stdout || ''}${run.stderr || ''}`.trim();
    if (run.status !== 0) {
      throw new Error(`openpyxl 写出失败：${out.split('\n').slice(-3).join(' ')}`);
    }
    const lastLine = out.split('\n').filter(Boolean).pop() || '';
    let info = null;
    try {
      info = JSON.parse(lastLine);
    } catch (err) {
      info = null;
    }
    if (!info || !info.ok) throw new Error(`openpyxl 写出异常：${lastLine || out}`);
    return info;
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (err) {
      /* 临时目录清不掉不影响结果 */
    }
  }
}

function uniquePath(dir, base, ext) {
  fs.mkdirSync(dir, { recursive: true });
  let target = path.join(dir, `${base}${ext}`);
  let i = 2;
  while (fs.existsSync(target)) {
    target = path.join(dir, `${base}(${i})${ext}`);
    i += 1;
  }
  return target;
}

/**
 * 写出 xlsx。以模板为底板重写数据区，保留模板的表头样式与列宽。
 * 优先走 openpyxl（样式完整）；不可用时退回 SheetJS（数据正确但样式会退成默认）。
 * @returns {{ file, rowCount, dayCount, problems, templateUsed, writer }}
 */
function exportWorkbook(roster, schedule, ym, options) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  const { rows, problems } = buildRows(roster, schedule, ym, opts);
  if (rows.length === 0) throw new Error(`${ym} 一条排班都没有，导出没有意义`);

  const preview = rows.slice(0, opts.previewCount || 3).map((r) => ({
    date: r.date,
    shift: r.shift,
    start: r.start,
    end: r.end,
    orgName: r.cells[4],
    deptName: r.cells[5],
    code: r.cells[6],
    title: r.cells[7],
    room: r.cells[8],
    triageDesk: r.cells[9],
  }));

  // 试算模式：只算不写，界面用来预览行数和列对应关系
  if (opts.dryRun) {
    return {
      dryRun: true,
      file: null,
      defaultFileName: `号源排班-${ym}.xlsx`,
      rowCount: rows.length,
      dayCount: new Set(rows.map((r) => r.date)).size,
      problems,
      templateUsed: fs.existsSync(TEMPLATE_FILE),
      rows: preview,
    };
  }

  // outFile 是界面里用户确认过的完整路径 → 直接用它；
  // 否则按 outDir + 标准文件名生成（同名时自动加序号，不覆盖已有文件）
  const outFile =
    opts.outFile ||
    uniquePath(opts.outDir || EXPORT_DIR, `号源排班-${ym}`, '.xlsx');
  // 目标文件夹可能还不存在（用户手输了路径，或换了台电脑），先建出来
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const templateUsed = fs.existsSync(TEMPLATE_FILE);
  const base = {
    file: outFile,
    rowCount: rows.length,
    dayCount: new Set(rows.map((r) => r.date)).size,
    problems,
    templateUsed,
    rows: preview,
  };

  const python = findPython();
  if (python) {
    writeWithPython(python, { templateUsed }, rows, outFile);
    return Object.assign(base, { writer: 'openpyxl' });
  }

  writeWithSheetJS(rows, outFile, templateUsed);
  return Object.assign(base, {
    writer: 'sheetjs',
    notice: '本机没找到带 openpyxl 的 Python，导出用的是兼容写法，样式会退回 Excel 默认。',
  });
}

/** 后备方案：纯 Node 写，样式会丢，但列结构、日期文本格式正确 */
function writeWithSheetJS(rows, outFile, templateUsed) {
  let wb;
  if (templateUsed) {
    wb = XLSX.readFile(TEMPLATE_FILE);
  } else {
    wb = XLSX.utils.book_new();
  }
  const sheetName = wb.SheetNames.includes('号源排班') ? '号源排班' : wb.SheetNames[0] || '号源排班';
  if (!wb.Sheets[sheetName]) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), sheetName);

  const matrix = [store.EXPORT_COLUMNS.slice(), ...rows.map((r) => r.cells)];
  const ws = wb.Sheets[sheetName];
  for (const addr of Object.keys(ws)) {
    if (addr[0] !== '!') delete ws[addr];
  }
  XLSX.utils.sheet_add_aoa(ws, matrix, { origin: { r: 0, c: 0 }, nullError: false });
  ws['!ref'] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: matrix.length - 1, c: store.EXPORT_COLUMNS.length - 1 },
  });
  for (const addr of Object.keys(ws)) {
    if (addr[0] === '!') continue;
    const idx = XLSX.utils.decode_cell(addr).c;
    if ([0, 1, 2, 3].includes(idx) && ws[addr].t === 's') ws[addr].z = '@';
  }
  XLSX.writeFile(wb, outFile, { bookType: 'xlsx', compression: true });
}

module.exports = {
  ROOT,
  TEMPLATE_FILE,
  EXPORT_DIR,
  PY_WORKER,
  buildRows,
  buildMatrix,
  exportWorkbook,
  writeWithSheetJS,
  writeWithPython,
  findPython,
  uniquePath,
  shiftTime,
};
