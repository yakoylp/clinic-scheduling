'use strict';
/**
 * 测试专用：把数据目录和导出目录固定到临时目录。
 *
 * 为什么必须这样：这些测试会清空、重建数据目录，如果指向工程的 data/，
 * 一跑 npm test 就会把用户的真实排班数据删掉。所有测试脚本都要在
 * require('../lib/store') **之前**先 require 本文件。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.DSH_SCHEDULE_DATA) {
  const dir = path.join(os.tmpdir(), `clinic-schedule-test-${process.pid}`, 'data');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  process.env.DSH_SCHEDULE_DATA = dir;
}
if (!process.env.DSH_SCHEDULE_OUT) {
  const out = path.join(os.tmpdir(), `clinic-schedule-test-${process.pid}`, '导出');
  fs.mkdirSync(out, { recursive: true });
  process.env.DSH_SCHEDULE_OUT = out;
}

module.exports = {
  dataDir: process.env.DSH_SCHEDULE_DATA,
  outDir: process.env.DSH_SCHEDULE_OUT,
};
