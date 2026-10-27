'use strict';
/**
 * 「复制排班视图」：把当前月份的整张排班表（含表头）画成一张长图，写进系统剪贴板，
 * 之后在微信 / QQ / 文档里直接 Ctrl+V 就能粘出来。
 *
 * 画图用原生 Canvas，不引入任何第三方库：排班表就是规则的表格，
 * 自己按行列画反而更清楚——字体、行高、颜色都能和界面保持一致。
 * 真正写剪贴板在主进程（electron/api.js 的 clipboard:image）。
 */

const CopyView = {
  /** 输出倍率：2 倍图，粘到聊天窗口里不糊 */
  SCALE: 2,
  PADDING: 22,
  TITLE_HEIGHT: 56,
  HEADER_HEIGHT: 42,
  ROW_HEIGHT: 38,
  COL_DATE: 76,
  COL_WEEKDAY: 58,
  COL_SHIFT: 100,
  COL_ROOM: 118,

  /** 把当前排班整理成「画图用的版式数据」，纯数据、不碰 DOM，方便测试 */
  buildLayout() {
    const month = App.month;
    if (!month) throw new Error('还没加载月份数据');
    const days = App.days || [];
    const shifts = App.shifts || [];
    const rooms = (App.rooms || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const settings = (App.snapshot && App.snapshot.settings) || {};
    const dept = String(settings.deptName || '').trim();
    const stats = App.stats || { filled: 0, total: 0 };

    const width = this.PADDING * 2 + this.COL_DATE + this.COL_WEEKDAY + this.COL_SHIFT + rooms.length * this.COL_ROOM;
    const bodyRows = days.length * Math.max(shifts.length, 1);
    const height = this.PADDING * 2 + this.TITLE_HEIGHT + this.HEADER_HEIGHT + bodyRows * this.ROW_HEIGHT;

    const title = `${dept ? `${dept} ` : ''}${month.year} 年 ${month.month} 月 医生排班表`;

    const dateBlocks = days.map((day) => {
      const rows = shifts.map((shift) => {
        const t = (month.shiftTimes || {})[`${day.date}|${shift.name}`] || {};
        const timeText = t.start ? `${String(t.start).slice(11, 16)}-${String(t.end).slice(11, 16)}` : '';
        const cells = rooms.map((room) => {
          const key = App.slotKey(day.date, shift.name, room.id);
          const docId = App.slot(day.date, shift.name, room.id);
          const doc = docId ? App.doctor(docId) : null;
          const times = App.slotTime(key) || {};
          return {
            roomId: room.id,
            doctorId: docId || null,
            name: doc ? doc.name : '',
            color: doc ? doc.color : '',
            empty: !doc,
            badge: this.cellBadge(times, shift),
          };
        });
        return { shift: shift.name, timeText, cells };
      });
      return {
        date: day.date,
        day: day.day,
        weekdayName: day.weekdayName,
        isWeekend: !!day.isWeekend,
        rows,
      };
    });

    return {
      width,
      height,
      padding: this.PADDING,
      titleHeight: this.TITLE_HEIGHT,
      headerHeight: this.HEADER_HEIGHT,
      rowHeight: this.ROW_HEIGHT,
      // 列宽也放进版式数据里：draw() 只依赖 layout，避免用到 this 上的字段导致坐标算错
      colDate: this.COL_DATE,
      colWeekday: this.COL_WEEKDAY,
      colShift: this.COL_SHIFT,
      colRoom: this.COL_ROOM,
      title,
      subRight: `已排 ${stats.filled || 0}/${stats.total || 0} 格`,
      columns: [
        { key: 'date', label: '日期', width: this.COL_DATE },
        { key: 'weekday', label: '星期', width: this.COL_WEEKDAY },
        { key: 'shift', label: '班次', width: this.COL_SHIFT },
        ...rooms.map((r) => ({ key: `room:${r.id}`, label: r.short || r.name, width: this.COL_ROOM })),
      ],
      rooms,
      dateBlocks,
      bodyRows,
    };
  },

  /**
   * 格子右上角的小标记：和班次默认不一样时，显示开始时间或间隔。
   * 规则和界面上格子的角标一致，避免截图丢信息。
   */
  cellBadge(times, shift) {
    if (!times || !times.customized) return '';
    const conf = shift || {};
    const startChanged = times.start && times.start !== conf.start;
    if (startChanged) return String(times.start).slice(0, 5);
    if (String(times.interval) !== String(conf.interval)) return `${times.interval}分`;
    if (String(times.perInterval) !== String(conf.perInterval)) return `${times.perInterval}号`;
    return '';
  },

  /** 在 2D context 上把版式画出来（单位：CSS px，调用方已按 SCALE 缩放） */
  draw(ctx, layout) {
    const L = layout;
    const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
    const ink = '#1f2937';
    const dim = '#6b7280';
    const line = '#e2e6ee';
    const headBg = '#f8fafc';

    // 背景
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, L.width, L.height);

    const left = L.padding;
    const contentWidth = L.width - L.padding * 2;

    // ---------- 标题 ----------
    const titleCy = L.padding + L.titleHeight / 2;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = ink;
    ctx.font = `bold 21px ${FONT}`;
    ctx.fillText(L.title, left, titleCy);
    ctx.textAlign = 'right';
    ctx.fillStyle = dim;
    ctx.font = `13px ${FONT}`;
    ctx.fillText(L.subRight, left + contentWidth, titleCy);
    // 标题下面一条分隔线
    const headTop = L.padding + L.titleHeight;
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, headTop);
    ctx.lineTo(left + contentWidth, headTop);
    ctx.stroke();

    // ---------- 表头 ----------
    const headBottom = headTop + L.headerHeight;
    ctx.fillStyle = headBg;
    ctx.fillRect(left, headTop, contentWidth, L.headerHeight);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#334155';
    ctx.font = `bold 14px ${FONT}`;
    let x = left;
    for (const col of L.columns) {
      ctx.fillText(col.label, x + col.width / 2, headTop + L.headerHeight / 2);
      x += col.width;
    }

    // ---------- 表体 ----------
    const bodyTop = headBottom;
    const rowH = L.rowHeight;
    const COL_DATE = L.colDate;
    const COL_WEEKDAY = L.colWeekday;
    const COL_SHIFT = L.colShift;
    const COL_ROOM = L.colRoom;
    let y = bodyTop;
    for (const block of L.dateBlocks) {
      const blockH = Math.max(block.rows.length, 1) * rowH;
      const isWeekend = block.isWeekend;

      // 日期列 + 星期列（同一天的多个班次共用一个日期格，竖直居中）
      ctx.fillStyle = isWeekend ? '#fef3f2' : '#ffffff';
      ctx.fillRect(left, y, COL_DATE + COL_WEEKDAY, blockH);
      const blockCy = y + blockH / 2;
      ctx.textAlign = 'center';
      ctx.fillStyle = isWeekend ? '#c2410c' : ink;
      ctx.font = `bold 15px ${FONT}`;
      ctx.fillText(`${block.day}日`, left + COL_DATE / 2, blockCy);
      ctx.fillStyle = isWeekend ? '#c2410c' : dim;
      ctx.font = `12px ${FONT}`;
      ctx.fillText(block.weekdayName, left + COL_DATE + COL_WEEKDAY / 2, blockCy);
      block.rows.forEach((row, si) => {
        const rowY = y + si * rowH;
        const shiftCx = left + COL_DATE + COL_WEEKDAY + COL_SHIFT / 2;

        // 班次列：班次名 + 该班次时间
        ctx.textAlign = 'center';
        ctx.fillStyle = ink;
        ctx.font = `bold 13px ${FONT}`;
        const shiftTextY = row.timeText ? rowY + rowH / 2 - 7 : rowY + rowH / 2;
        ctx.fillText(row.shift, shiftCx, shiftTextY);
        if (row.timeText) {
          ctx.fillStyle = dim;
          ctx.font = `10px ${FONT}`;
          ctx.fillText(row.timeText, shiftCx, rowY + rowH / 2 + 10);
        }

        // 各诊室
        row.cells.forEach((cell, ci) => {
          const cx = left + COL_DATE + COL_WEEKDAY + COL_SHIFT + ci * COL_ROOM;
          if (cell.empty) {
            ctx.fillStyle = isWeekend ? '#fef3f2' : '#ffffff';
            ctx.fillRect(cx, rowY, COL_ROOM, rowH);
            ctx.fillStyle = '#d3d9e4';
            ctx.font = `13px ${FONT}`;
            ctx.textAlign = 'center';
            ctx.fillText('—', cx + COL_ROOM / 2, rowY + rowH / 2);
          } else {
            ctx.fillStyle = tint(cell.color, isWeekend ? 0.26 : 0.14);
            ctx.fillRect(cx, rowY, COL_ROOM, rowH);
            ctx.fillStyle = cell.color || ink;
            ctx.font = `bold 14px ${FONT}`;
            ctx.textAlign = 'center';
            ctx.fillText(cell.name, cx + COL_ROOM / 2, rowY + rowH / 2);
            if (cell.badge) {
              ctx.fillStyle = '#1d4ed8';
              ctx.font = `9px ${FONT}`;
              ctx.textAlign = 'left';
              ctx.fillText(cell.badge, cx + 4, rowY + 9);
            }
          }
        });
      });

      y += blockH;
    }

    // ---------- 网格线 ----------
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    // 竖线
    const colEdges = [left];
    for (const col of L.columns) colEdges.push(colEdges[colEdges.length - 1] + col.width);
    for (const cx of colEdges) {
      ctx.beginPath();
      ctx.moveTo(cx + 0.5, headTop);
      ctx.lineTo(cx + 0.5, bodyTop + L.bodyRows * rowH);
      ctx.stroke();
    }    // 横线（表头上下 + 每行）
    for (let i = 0; i <= L.bodyRows; i += 1) {
      const ly = bodyTop + i * rowH;
      ctx.beginPath();
      ctx.moveTo(left, ly + 0.5);
      ctx.lineTo(left + contentWidth, ly + 0.5);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(left, headBottom + 0.5);
    ctx.lineTo(left + contentWidth, headBottom + 0.5);
    ctx.stroke();

    return { width: L.width, height: L.height };
  },

  /** 画布 -> PNG dataURL。抽成单独方法，测试里可以打桩 */
  renderToDataUrl(layout) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(layout.width * this.SCALE);
    canvas.height = Math.ceil(layout.height * this.SCALE);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前环境不支持画布绘制');
    ctx.scale(this.SCALE, this.SCALE);
    this.draw(ctx, layout);
    return canvas.toDataURL('image/png');
  },

  /** 按钮入口：画图并写进剪贴板 */
  async copy() {
    const btn = $('#btnCopyView');
    if (!App.month) {
      toast('还没加载月份数据', 'err');
      return null;
    }
    if (!(App.days || []).length) {
      toast('这个月没有日期，先去「科室设置」检查月份范围', 'err');
      return null;
    }
    if (btn) btn.disabled = true;
    try {
      const layout = this.buildLayout();
      const dataUrl = this.renderToDataUrl(layout);
      const res = await call(window.api.copyImage, dataUrl);
      const w = (res && res.width) || layout.width * this.SCALE;
      const h = (res && res.height) || layout.height * this.SCALE;
      toast(`排班表已复制成图片（${w}×${h}），到微信/QQ 里 Ctrl+V 粘贴即可`, 'ok');
      return { width: w, height: h };
    } catch (err) {
      toast(`复制失败：${err.message}`, 'err');
      return null;
    } finally {
      if (btn) btn.disabled = false;
    }
  },
};

document.addEventListener('DOMContentLoaded', () => {
  const btn = $('#btnCopyView');
  if (btn) btn.onclick = () => CopyView.copy();
});
