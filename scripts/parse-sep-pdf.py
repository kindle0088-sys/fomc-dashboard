"""
SEP 点阵图 PDF 回退解析器

用途：部分年份的 SEP HTML 版缺失（如 2022-03、2020-03），但 PDF 存在。
      PDF 的 Figure 2 点阵为矢量绘制，每个空心圆 = 一位参与者，
      通过解析绘图对象坐标可精确还原「人数 × 利率档位」。

坐标系映射：
  - 每个圆点 rect 中心 → (x, y)
  - x 轴按年份分组（4 组或 5 组，等距）
  - y 轴 → 利率（取刻度标签的 y 坐标线性拟合）
  - 利率四舍五入到最近的 1/8 个点（0.125）

输出 JSON 到 stdout，结构与 collect-sep.mjs 的 HTML 解析结果一致。
"""

import sys
import json
import re
import urllib.request
from collections import defaultdict


def load_pdf_bytes(date: str) -> bytes:
    url = f"https://www.federalreserve.gov/monetarypolicy/files/fomcprojtabl{date}.pdf"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=90).read()


def find_dot_page(doc):
    """定位含 Figure 2 点阵的页"""
    for i in range(doc.page_count):
        t = doc[i].get_text()
        if "Midpoint of target range" in t and "Figure 2" in t:
            return i
    for i in range(doc.page_count):
        if "Midpoint of target range" in doc[i].get_text():
            return i
    return None


def parse_axis_labels(text):
    """从文本层提取 y 轴利率刻度与 x 轴年份标签"""
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    pct = []
    years = []
    yr_re = re.compile(r"^(20\d\d|Longer run)$", re.I)
    for i, l in enumerate(lines):
        if re.fullmatch(r"\d\.\d", l):
            v = float(l)
            if 0.0 <= v <= 8.0:
                pct.append(v)
        if yr_re.match(l):
            years.append(l)
    return pct, years


def extract_dots(page):
    """提取所有圆点（曲线绘制 + 正方形包围盒 + 等宽高）"""
    dots = []
    for d in page.get_drawings():
        kinds = {it[0] for it in d["items"]}
        if "c" not in kinds:
            continue
        r = d["rect"]
        if r.width <= 0 or r.height <= 0:
            continue
        if abs(r.width - r.height) > 0.5:      # 圆点必为正方形包围盒
            continue
        if not (2.0 <= r.width <= 6.0):         # 尺寸筛选
            continue
        dots.append({"x": (r.x0 + r.x1) / 2, "y": (r.y0 + r.y1) / 2})
    return dots


def main(date: str):
    import pymupdf

    raw = load_pdf_bytes(date)
    doc = pymupdf.open(stream=raw, filetype="pdf")
    pi = find_dot_page(doc)
    if pi is None:
        print(json.dumps({"date": date, "ok": False, "err": "dot page not found"}))
        return

    page = doc[pi]
    text = page.get_text()
    pct_labels, year_labels = parse_axis_labels(text)
    dots = extract_dots(page)

    if not dots or len(pct_labels) < 3 or not year_labels:
        print(json.dumps({
            "date": date, "ok": False,
            "err": f"insufficient data: dots={len(dots)} pct={len(pct_labels)} years={len(year_labels)}"
        }))
        return

    # --- y 轴：用刻度标签的 y 坐标线性拟合利率 ---
    # 找文本块中每个刻度数字的位置
    ys = []
    for w in page.get_text("words"):
        x0, y0, x1, y1, word = w[0], w[1], w[2], w[3], w[4]
        if re.fullmatch(r"\d\.\d", word):
            try:
                v = float(word)
            except ValueError:
                continue
            if 0.0 <= v <= 8.0:
                ys.append((y0 + y1) / 2, )
                ys[-1] = ((y0 + y1) / 2, v)
    if len(ys) < 3:
        print(json.dumps({"date": date, "ok": False, "err": "axis fit failed"}))
        return

    ys_sorted = sorted(ys)
    # 线性拟合 y(px) → 利率
    n = len(ys_sorted)
    sx = sum(p[0] for p in ys_sorted)
    sy = sum(p[1] for p in ys_sorted)
    sxx = sum(p[0] * p[0] for p in ys_sorted)
    sxy = sum(p[0] * p[1] for p in ys_sorted)
    denom = n * sxx - sx * sx
    if abs(denom) < 1e-9:
        print(json.dumps({"date": date, "ok": False, "err": "degenerate axis fit"}))
        return
    slope = (n * sxy - sx * sy) / denom
    inter = (sy - slope * sx) / n

    def y2rate(y_px):
        return slope * y_px + inter

    # --- x 轴：年份分组，等距分箱 ---
    xs = sorted(d["x"] for d in dots)
    xmin, xmax = xs[0], xs[-1]
    nyears = len(year_labels)
    span = xmax - xmin
    # 用年份数均分（首个年份组中心 = xmin，末组中心 = xmax）
    if nyears > 1 and span > 0:
        step = span / (nyears - 1)
    else:
        step = 1.0

    def x2year(x):
        if nyears == 1:
            return year_labels[0]
        idx = round((x - xmin) / step)
        idx = max(0, min(nyears - 1, idx))
        return year_labels[idx]

    # --- 汇总：horizon × 档位 → 人数 ---
    buckets = defaultdict(lambda: defaultdict(int))
    for d in dots:
        hz = x2year(d["x"])
        rate = y2rate(d["y"])
        r8 = round(rate * 8) / 8          # 四舍五入到 1/8 点
        buckets[hz][round(r8, 3)] += 1

    points = []
    for hz, mp in buckets.items():
        for rate, cnt in mp.items():
            points.append({"horizon": hz, "rate": rate, "count": cnt})

    # 中值：从表 1 文本抽取 Federal funds rate 行
    median = None
    median_horizons = None
    for i in range(doc.page_count):
        t = doc[i].get_text()
        if "Federal funds rate" in t and "Change in real GDP" in t:
            lines = [l.strip() for l in t.split("\n") if l.strip()]
            try:
                k = lines.index("Federal funds rate")
            except ValueError:
                continue
            vals = []
            j = k + 1
            while j < len(lines) and len(vals) < len(year_labels):
                if re.fullmatch(r"\d+\.\d+", lines[j]):
                    vals.append(float(lines[j]))
                j += 1
            if len(vals) >= len(year_labels):
                median = vals[: len(year_labels)]
                median_horizons = year_labels
            break

    print(json.dumps({
        "date": date,
        "ok": True,
        "source": f"pdf: fomcprojtabl{date}.pdf (page {pi+1}), {len(dots)} dots",
        "horizons": year_labels,
        "median": median,
        "medianHorizons": median_horizons,
        "points": sorted(points, key=lambda p: (p["horizon"], p["rate"])),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "20220316")
