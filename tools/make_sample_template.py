# -*- coding: utf-8 -*-
"""
从一份排班模板生成「示例模板」：表头、列宽、字体、对齐全部保留，只把数据行换成虚构样例。
用于开源仓库——发布版不能带真实医院的样例数据。

用法：
  python tools/make_sample_template.py <源模板.xlsx> <输出.xlsx>
"""
import sys

from openpyxl import load_workbook

SHEET = "号源排班"

# 虚构样例：日期统一用同一个月的连续几天，人/诊室/科室全部是占位名
SAMPLE_ROWS = [
    ["2027-03-01", "上午", "2027-03-01 08:00:00", "2027-03-01 12:00:00", "", "示例科室", "doctor001", "医师", "示例诊室1", "示例分诊台"],
    ["2027-03-01", "下午", "2027-03-01 14:30:00", "2027-03-01 17:30:00", "", "示例科室", "doctor001", "医师", "示例诊室1", "示例分诊台"],
    ["2027-03-01", "上午", "2027-03-01 08:00:00", "2027-03-01 12:00:00", "", "示例科室", "doctor002", "副主任医师", "示例诊室2", "示例分诊台"],
    ["2027-03-01", "下午", "2027-03-01 14:30:00", "2027-03-01 17:30:00", "", "示例科室", "doctor002", "副主任医师", "示例诊室2", "示例分诊台"],
    ["2027-03-02", "上午", "2027-03-02 08:00:00", "2027-03-02 12:00:00", "", "示例科室", "doctor003", "主治医师", "示例诊室3", "示例分诊台"],
    ["2027-03-02", "下午", "2027-03-02 14:30:00", "2027-03-02 17:30:00", "", "示例科室", "doctor003", "主治医师", "示例诊室3", "示例分诊台"],
]


def main(src, dst):
    wb = load_workbook(src)
    ws = wb[SHEET] if SHEET in wb.sheetnames else wb[wb.sheetnames[0]]

    # 数据从第 2 行开始；把原有的数据行全部清空（保留样式模板行）
    first_data_row = 2
    style_row = first_data_row
    last_row = ws.max_row

    for r in range(first_data_row, last_row + 1):
        for c in range(1, ws.max_column + 1):
            ws.cell(row=r, column=c).value = None

    # 按示例数据回填，样式沿用原来第 2 行那一套
    for i, row in enumerate(SAMPLE_ROWS):
        r = first_data_row + i
        for c, value in enumerate(row, start=1):
            cell = ws.cell(row=r, column=c)
            if i > 0:
                src_cell = ws.cell(row=style_row, column=c)
                cell._style = src_cell._style
            cell.value = value if value != "" else None
            # 日期和时间保持文本，别被 Excel 变成序列号
            if c in (1, 2, 3, 4):
                cell.number_format = "@"

    # 把超出的空行删掉，保持文件干净
    if last_row > first_data_row + len(SAMPLE_ROWS) - 1:
        ws.delete_rows(first_data_row + len(SAMPLE_ROWS), last_row - (first_data_row + len(SAMPLE_ROWS)) + 1)

    wb.save(dst)
    print(f"已写出示例模板：{dst}")
    print(f"  sheet={ws.title} 表头 {ws.max_column} 列，示例数据 {len(SAMPLE_ROWS)} 行")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    main(sys.argv[1], sys.argv[2])
