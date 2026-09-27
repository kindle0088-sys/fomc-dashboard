/**
 * SEP 点阵图采集器
 *
 * 数据源：美联储官方 SEP HTML 页面
 *   https://www.federalreserve.gov/monetarypolicy/fomcprojtablYYYYMMDD.htm
 *   其中的 "Midpoint of target range or target level" 表格 = 点阵分布原始数据
 *
 * 产出：data/raw/sep/<YYYYMMDD>.json（每期一个文件）
 *       data/derived/sep-series.json（多期汇总，供看板消费）
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');
const RAW = path.join(DATA, 'raw', 'sep');

/** Python 解释器候选（不硬编码版本目录） */
const PY_CANDIDATES = (() => {
  const base = 'C:/Users/jiali/.workbuddy/binaries/python/versions';
  const out = [];
  try {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'python.exe');
      if (fs.existsSync(p)) out.push(p.replace(/\\/g, '/'));
    }
    // 优先较新版本
    out.sort().reverse();
  } catch { /* ignore */ }
  out.push('python');
  return out;
})();

// 2021-2026 全部带 SEP 的会议（日期 = 会议最后一日 / 决议日，美东）
const MEETINGS = [
  '20210317', '20210616', '20210922', '20211215',
  '20220316', '20220615', '20220921', '20221214',
  '20230322', '20230614', '20230920', '20231213',
  '20240320', '20240612', '20240918', '20241218',
  '20250319', '20250618', '20250917', '20251210',
  '20260318', '20260617', '20260916',
];

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; FOMC-dashboard/1.0)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 取表格文本（去标签） */
function cellText(c) {
  return c.replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function tableRows(html) {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(tr =>
    [...tr[1].matchAll(/<(t[dh])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(m => cellText(m[2]))
  );
}

/**
 * 解析点阵分布表
 * 结构：首行表头 = Midpoint... | 2026 | 2027 | 2028 | 2029 | Longer run
 *       其余行 = 利率档位 | 各年人数...（空格子 = 0 人）
 */
function parseDotPlot(html) {
  const tabs = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)];
  let target = null;
  for (const t of tabs) {
    const txt = t[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
    if (/Midpoint of target range/i.test(txt)) { target = t[1]; break; }
  }
  if (!target) return null;

  const rows = tableRows(target).filter(r => r.some(x => x !== ''));
  if (!rows.length) return null;

  // 表头：找含年份的那一行
  const hIdx = rows.findIndex(r => r.some(c => /20\d\d/.test(c) || /Longer run/i.test(c)));
  if (hIdx < 0) return null;
  const header = rows[hIdx];
  // 列定义：跳过第一列（利率档位）
  const years = header.slice(1).filter(Boolean);

  const points = [];
  for (const r of rows.slice(hIdx + 1)) {
    if (r.length < 2) continue;
    const rate = parseFloat(String(r[0]).replace(/[^\d.]/g, ''));
    if (!Number.isFinite(rate)) continue;
    const counts = r.slice(1);
    years.forEach((y, i) => {
      const n = parseInt(String(counts[i] ?? '').replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(n) && n > 0) {
        points.push({ horizon: y.trim(), rate, count: n });
      }
    });
  }
  return { header: header.slice(1), points };
}

/**
 * 解析表 1 的联邦基金利率中值（仅取 Median 段）
 *
 * 表 1 结构：Variable | Median(D1..Dk) | Central Tendency(D1..Dk) | Range(D1..Dk)
 * 首行给出三段各自的 horizon 标签，故根据表头行统计每段长度。
 */
function parseMedianFfr(html) {
  const tabs = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)];
  for (const t of tabs) {
    const txt = t[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
    if (!/Change in real GDP/i.test(txt) || !/Federal funds rate/i.test(txt)) continue;

    const rows = tableRows(t[1]).filter(r => r.some(x => x !== ''));
    // 表头行：含多个年份标签
    const hIdx = rows.findIndex(r => (r.filter(c => /^20\d\d$/.test(c)).length >= 2));
    if (hIdx < 0) continue;

    // 找 Federal funds rate 行（表 1 最后一行）
    const fr = rows.find(r => /^Federal funds rate/i.test(r[0]));
    if (!fr) continue;

    const vals = fr.slice(1);            // 去掉变量名
    // 数据行总长 = 3 段 × N，故 N = len/3
    const N = Math.round(vals.length / 3);
    if (!Number.isFinite(N) || N < 1) continue;

    // 表头行长度 = 3N（三段年份标签拼接），取前 N 个作为 Median 段的 horizon
    const hdr = rows[hIdx];
    const horizons = hdr.slice(0, N).map(x => x.trim()).filter(Boolean);

    const median = vals.slice(0, N).map(v => parseFloat(v)).filter(Number.isFinite);
    const range = vals.slice(2 * N, 3 * N).map(v => String(v).trim());

    return { horizons, median, range, cols: N };
  }
  return null;
}

async function fetchOne(date) {
  const url = `https://www.federalreserve.gov/monetarypolicy/fomcprojtabl${date}.htm`;
  const r = await fetch(url, { headers: UA });
  if (r.ok) {
    const html = await r.text();
    const dot = parseDotPlot(html);
    const ffr = parseMedianFfr(html);
    if (dot) {
      const totalByHorizon = {};
      for (const p of dot.points) totalByHorizon[p.horizon] = (totalByHorizon[p.horizon] || 0) + p.count;
      return {
        date, ok: true, url,
        horizons: dot.header,
        points: dot.points,
        median: ffr ? ffr.median : null,
        medianHorizons: ffr ? ffr.horizons : null,
        range: ffr ? ffr.range : null,
        totalByHorizon,
      };
    }
  }

  // ── PDF 回退：部分年份 HTML 缺失（如 2022-03），但 PDF 存在且点阵为矢量绘制 ──
  const pdfRes = await fetchOneFromPdf(date);
  if (pdfRes.ok) return pdfRes;

  return { date, ok: false, status: r.status, err: `html(${r.status}) + pdf(${pdfRes.err})` };
}

/** 调用 Python 解析 PDF 点阵 */
async function fetchOneFromPdf(date) {
  const py = PY_CANDIDATES.find(p => fs.existsSync(p));
  if (!py) return { date, ok: false, err: 'python not found' };
  const script = path.join(HERE, 'parse-sep-pdf.py');
  if (!fs.existsSync(script)) return { date, ok: false, err: 'parse-sep-pdf.py missing' };

  try {
    const r = spawnSync(py, [script, date], { encoding: 'utf8', timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
    if (r.error) return { date, ok: false, err: `spawn ${r.error.code}` };
    if (r.status !== 0) return { date, ok: false, err: `py exit ${r.status}` };
    // 兼容 stdout 前有 warning 的情况：取最后一个 JSON 行
    const line = String(r.stdout || '').trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
    if (!line) return { date, ok: false, err: 'no json from py' };
    const j = JSON.parse(line);
    if (!j.ok) return { date, ok: false, err: j.err };
    return { ...j, ok: true, via: 'pdf' };
  } catch (e) {
    return { date, ok: false, err: e.message };
  }
}

async function main() {
  fs.mkdirSync(RAW, { recursive: true });
  const out = [];
  const fail = [];
  for (const d of MEETINGS) {
    try {
      const res = await fetchOne(d);
      if (res.ok) {
        fs.writeFileSync(path.join(RAW, `${d}.json`), JSON.stringify(res, null, 2), 'utf8');
        const n = res.points.length;
        console.log(`✓ ${d}  ${n} 个点  horizons=${res.horizons.join('/')}  中值=${JSON.stringify(res.median)}`);
        out.push({ date: d, file: `sep/${d}.json`, points: n });
      } else {
        console.log(`✗ ${d}  HTTP ${res.status}${res.err ? ' (' + res.err + ')' : ''}`);
        fail.push(d);
      }
    } catch (e) {
      console.log(`✗ ${d}  ${e.message}`);
      fail.push(d);
    }
    await sleep(300);
  }

  // 汇总派生文件：直接扫描 data/raw/sep/ 目录，纳入历史抓取与 PDF 手工补录的全部期数
  const allDates = fs.readdirSync(RAW)
    .filter(f => /^\d{8}\.json$/.test(f))
    .map(f => f.replace('.json', ''))
    .sort();

  const series = allDates.map(d => {
    const j = JSON.parse(fs.readFileSync(path.join(RAW, `${d}.json`), 'utf8'));
    return { date: d, horizons: j.horizons, median: j.median, range: j.range || null, points: j.points, via: j.via || 'html' };
  });

  fs.mkdirSync(path.join(DATA, 'derived'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'derived', 'sep-series.json'),
    JSON.stringify({ source: 'Federal Reserve official SEP (HTML fomcprojtablYYYYMMDD.htm, PDF fallback via vector dot extraction)', generated: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), series }, null, 2), 'utf8');

  const viaHtml = series.filter(s => s.via === 'html').length;
  const viaPdf = series.filter(s => s.via === 'pdf').length;
  console.log(`\n本轮抓取：${out.length} 期成功 / ${fail.length} 期失败${fail.length ? ' → ' + fail.join(', ') : ''}`);
  console.log(`汇总入库：${series.length} 期（HTML ${viaHtml} / PDF 回退 ${viaPdf}）`);
  console.log(`覆盖：${series[0].date} → ${series[series.length - 1].date}`);
  console.log(`→ data/derived/sep-series.json`);
}

export { main, parseDotPlot, parseMedianFfr, MEETINGS };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
