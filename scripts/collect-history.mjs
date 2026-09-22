/**
 * FOMC 看板 · 长历史采集器（L4 情景层的数据基座）
 *
 * 目的：为事件研究（event study）提供日频资产序列 + 自动探测加息事件日。
 *
 * 数据源：
 *   Yahoo v8 chart API —— 股票/汇率/商品/ETF/波动率（长历史）
 *     关键写法 period1=0&period2=<now>&interval=1d
 *     ⚠️ 不能用 range=max：Yahoo 会静默降频到季度粒度（中位间隔 91 天）
 *   FRED fredgraph.csv —— 国债收益率（1962 年起）
 *
 * 输出：
 *   data/history/series.json   各资产 [[日期, 值], ...]（1985 起）
 *   data/history/rate-events.json  自动探测的加息事件 + 目标区间上限序列
 *
 * 用法：
 *   node collect-history.mjs              # 全量刷新
 *   node collect-history.mjs --events-only # 只刷新事件探测
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');
const CONFIG = path.join(ROOT, 'config');
const HIST = path.join(DATA, 'history');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 30000;

const log = (...a) => console.log(...a);
const ensureDir = p => fs.mkdirSync(p, { recursive: true });
const readJson = (p, fb = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const writeJson = (p, o) => { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(o), 'utf8'); };

async function getText(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, Accept: '*/*' } });
    return { status: r.status, text: await r.text() };
  } finally { clearTimeout(timer); }
}

// ---------- Yahoo ----------

async function fetchYahoo(entry) {
  const now = Math.floor(Date.now() / 1000);
  // 必须用 period1/period2，range=max 会降频到季度
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(entry.symbol)}`
    + `?period1=0&period2=${now}&interval=1d&events=div%2Csplit`;
  const { status, text } = await getText(url);
  let j = null;
  try { j = JSON.parse(text); } catch { /* noop */ }
  const res = j?.chart?.result?.[0];
  if (status !== 200 || !res) return { ...entry, ok: false, status, obs: [], err: j?.chart?.error?.description || null };

  const ts = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const adj = res.indicators?.adjclose?.[0]?.adjclose || [];
  const obs = [];
  for (let i = 0; i < ts.length; i++) {
    // 优先复权收盘（ETF 含分红，反映持有回报）；缺失时退回名义收盘
    const v = Number.isFinite(adj[i]) ? adj[i] : q.close?.[i];
    if (!Number.isFinite(v)) continue;
    const d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    obs.push([d, Math.round(v * 10000) / 10000]);
  }
  return { ...entry, ok: obs.length > 0, status, obs, err: null };
}

// ---------- FRED ----------

async function fetchFred(entry) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${entry.id}`;
  const { status, text } = await getText(url);
  if (status !== 200) return { ...entry, ok: false, status, obs: [] };
  const obs = [];
  for (const line of text.trim().split(/\r?\n/).slice(1)) {
    const [d, raw] = line.split(',');
    const v = parseFloat(raw);
    if (!d || !Number.isFinite(v)) continue;
    obs.push([d, v]);
  }
  return { ...entry, ok: obs.length > 0, status, obs };
}

// ---------- 加息事件探测 ----------

/**
 * 拼接 DFEDTAR（1982–2008）+ DFEDTARU（2008–今）得到目标区间上限的完整日频序列，
 * 再找所有「上调」日。这些日期即政策真正生效日，可复算，不依赖人工录入。
 */
async function detectRateEvents(cfg) {
  const segs = [];
  for (const seg of cfg.segments) {
    const { status, text } = await getText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seg.id}`);
    if (status !== 200) { log(`  ✗ ${seg.id} HTTP ${status}`); continue; }
    const rows = [];
    for (const line of text.trim().split(/\r?\n/).slice(1)) {
      const [d, raw] = line.split(',');
      const v = parseFloat(raw);
      if (!d || !Number.isFinite(v)) continue;
      if (seg.from && d < seg.from) continue;
      if (seg.to && d > seg.to) continue;
      rows.push([d, v]);
    }
    log(`  ✓ ${seg.id.padEnd(9)} ${rows.length} 期  ${rows[0]?.[0]} → ${rows[rows.length - 1]?.[0]}`);
    segs.push(...rows);
  }
  segs.sort((a, b) => a[0].localeCompare(b[0]));

  const events = [];
  for (let i = 1; i < segs.length; i++) {
    const bp = Math.round((segs[i][1] - segs[i - 1][1]) * 10000) / 100;
    if (bp > 0) events.push({ date: segs[i][0], bp, from: segs[i - 1][1], to: segs[i][1] });
  }
  return { upperSeries: segs, events };
}

// ---------- 主流程 ----------

async function main() {
  const args = process.argv.slice(2);
  const eventsOnly = args.includes('--events-only');
  const now = new Date();
  const stamp = new Date(now.getTime() + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00');

  log('');
  log('═══════════════════════════════════════════');
  log('  FOMC 长历史采集（L4 情景层数据基座）');
  log('═══════════════════════════════════════════');

  const cfg = readJson(path.join(CONFIG, 'history-series.json'));
  if (!cfg) { log('✗ 读不到 config/history-series.json'); process.exit(1); }
  const START = cfg._startDate || '1985-01-01';
  ensureDir(HIST);

  const report = { collectedAt: stamp, start: START, series: {}, events: null, errors: [] };

  if (!eventsOnly) {
    log('');
    log(`▸ [1/2] 资产序列（起始 ${START}）`);
    const all = [...(cfg.yahoo || []), ...(cfg.fred || [])];
    const out = {};
    for (const entry of all) {
      try {
        const r = entry.symbol ? await fetchYahoo(entry) : await fetchFred(entry);
        const trimmed = (r.obs || []).filter(([d]) => d >= START);
        const latest = trimmed[trimmed.length - 1];
        if (r.ok && trimmed.length) {
          out[entry.key] = {
            key: entry.key, label: entry.label, kind: entry.kind, unit: entry.unit, group: entry.group,
            source: entry.symbol ? `Yahoo ${entry.symbol}` : `FRED ${entry.id}`,
            count: trimmed.length, first: trimmed[0][0], latestDate: latest[0], latestValue: latest[1],
            obs: trimmed,
          };
          log(`  ✓ ${entry.key.padEnd(9)} ${String(trimmed.length).padStart(6)} 期  ${trimmed[0][0]} → ${latest[0]}   最新 ${latest[1]}`);
        } else {
          log(`  ✗ ${entry.key.padEnd(9)} 失败 HTTP ${r.status}${r.err ? '  ' + r.err : ''}`);
          report.errors.push(`${entry.key}: HTTP ${r.status}`);
        }
      } catch (e) {
        log(`  ✗ ${entry.key.padEnd(9)} ${e.message}`);
        report.errors.push(`${entry.key}: ${e.message}`);
      }
    }
    writeJson(path.join(HIST, 'series.json'), { source: 'Yahoo v8 chart + FRED fredgraph.csv', fetchedAt: stamp, start: START, series: out });
    report.series = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { count: v.count, latest: v.latestValue, latestDate: v.latestDate }]));
  }

  log('');
  log('▸ [2/2] 加息事件探测（FRED DFEDTAR + DFEDTARU）');
  const ev = await detectRateEvents(cfg.rateEvents);
  log(`  ✓ 目标区间上限序列 ${ev.upperSeries.length} 期  ${ev.upperSeries[0]?.[0]} → ${ev.upperSeries[ev.upperSeries.length - 1]?.[0]}`);
  log(`  ✓ 探测到加息事件 ${ev.events.length} 次`);
  const since = ev.events.filter(e => e.date >= START);
  log(`    其中 ${START} 之后 ${since.length} 次：`);
  for (const e of since) log(`      ${e.date}  +${e.bp}bp  → ${e.to.toFixed(2)}%`);
  writeJson(path.join(HIST, 'rate-events.json'), {
    source: 'FRED DFEDTAR (1982-2008) + DFEDTARU (2008-now)',
    fetchedAt: stamp, formula: 'bp = (upper_t − upper_{t−1}) × 100',
    upperSeries: ev.upperSeries, events: ev.events,
  });
  report.events = { total: ev.events.length, sinceStart: since.length, latest: since[since.length - 1] || null };

  writeJson(path.join(HIST, 'last-history-collect.json'), report);

  log('');
  log('───────────────────────────────────────────');
  log(`  状态: ${report.errors.length === 0 ? 'OK' : 'PARTIAL'}   错误: ${report.errors.length}`);
  report.errors.forEach(e => log('   · ' + e));
  log(`  输出: data/history/series.json + rate-events.json`);
  log('───────────────────────────────────────────');
  log('');
  return report.errors.length ? 1 : 0;
}

main().then(c => process.exit(c)).catch(e => { console.error('FATAL', e); process.exit(1); });
