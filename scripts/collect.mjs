/**
 * FOMC 看板 · 数据采集器
 *
 * 三个来源：
 *   1. CME 30-Day Fed Funds Futures 结算价 → 完整曲线（回溯仅 ~7 天，必须每日抓）
 *   2. FRED 序列（无 key，fredgraph.csv）  → 现状层 + 资产反应
 *   3. 快照落盘                            → 永久留档，供事后 as-of 回测
 *
 * 用法：
 *   node collect.mjs              # 抓全部（CME + FRED）
 *   node collect.mjs --cme-only
 *   node collect.mjs --fred-only
 *   node collect.mjs --date 09/21/2026   # 指定 CME 结算日
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');
const CONFIG = path.join(ROOT, 'config');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 25000;

// ---------- 工具 ----------

function log(...a) { console.log(...a); }

async function getText(url, headers = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, Accept: '*/*', ...headers } });
    return { status: r.status, text: await r.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, headers = {}) {
  const { status, text } = await getText(url, { Accept: 'application/json', ...headers });
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保留 null，由调用方判断 */ }
  return { status, json, raw: text };
}

/** SGT 时区下的 YYYY-MM-DD */
function sgtDate(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** SGT 时区下的完整 ISO 时间戳 */
function sgtStamp(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00');
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

// ---------- 1. CME 联邦基金期货 ----------

/** MM/DD/YYYY */
function cmeDateStr(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

/**
 * 抓取某个结算日的 ZQ 全曲线。
 * CME 只在结算后（美东约 14:00 后 = SGT 次日凌晨）放出数据，且只保留约 7 个交易日。
 * 因此从指定日往前逐日回溯，直到拿到第一个非空结果。
 */
async function fetchCmeCurve(endpointTpl, productId, startDate, maxBack = 7) {
  for (let back = 0; back < maxBack; back++) {
    const d = new Date(startDate.getTime() - back * 86400000);
    const dateStr = cmeDateStr(d);
    const url = endpointTpl.replace('{productId}', productId).replace('{MM/DD/YYYY}', encodeURIComponent(dateStr));
    const { status, json, raw } = await getJson(url);
    if (status !== 200 || !json) {
      log(`    ${dateStr} → HTTP ${status}（跳过）`);
      continue;
    }
    const rows = Array.isArray(json.settlements) ? json.settlements : [];
    if (rows.length === 0 || json.empty === true) {
      log(`    ${dateStr} → 空（周末/未结算）`);
      continue;
    }
    return { tradeDate: json.tradeDate || dateStr, updateTime: json.updateTime || '', rows };
  }
  return null;
}

/** 把 CME 原始行转成结构化曲线 */
function parseCurve(rows) {
  const out = [];
  for (const r of rows) {
    const month = String(r.month || '').trim();
    if (!month || month === 'Total') continue;
    const settle = parseFloat(r.settle);
    if (!Number.isFinite(settle) || settle <= 0) continue; // 远月未成交，settle 为 "-"
    out.push({
      month,
      settle,
      impliedRate: Math.round((100 - settle) * 10000) / 10000,
      last: r.last || null,
      volume: Number(String(r.volume || '0').replace(/,/g, '')) || 0,
      openInterest: Number(String(r.openInterest || '0').replace(/,/g, '')) || 0,
    });
  }
  return out;
}

// ---------- 2. FRED ----------

async function fetchFredSeries(entry) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${entry.id}`;
  const { status, text } = await getText(url);
  if (status !== 200) return { ...entry, ok: false, status, obs: [] };

  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { ...entry, ok: false, status, obs: [] };

  const obs = [];
  for (let i = 1; i < lines.length; i++) {
    const [date, rawVal] = lines[i].split(',');
    if (!date || rawVal === undefined) continue;
    const v = parseFloat(rawVal);
    if (!Number.isFinite(v)) continue; // FRED 用 "." 表示缺失
    obs.push([date, v]);
  }
  return {
    ...entry,
    ok: obs.length > 0,
    status,
    count: obs.length,
    latestDate: obs.length ? obs[obs.length - 1][0] : null,
    latestValue: obs.length ? obs[obs.length - 1][1] : null,
    obs,
  };
}

// ---------- 派生指标 ----------

/** 环比年化（3 个月）：((P_t / P_{t-3})^4 - 1) * 100 */
function annualized3m(obs) {
  if (!obs || obs.length < 4) return null;
  const t = obs[obs.length - 1][1];
  const t3 = obs[obs.length - 4][1];
  if (!t || !t3) return null;
  return Math.round(((Math.pow(t / t3, 4) - 1) * 100) * 100) / 100;
}

function yoy(obs) {
  if (!obs || obs.length < 13) return null;
  const t = obs[obs.length - 1][1];
  const t12 = obs[obs.length - 13][1];
  if (!t || !t12) return null;
  return Math.round(((t / t12 - 1) * 100) * 100) / 100;
}

/** 最新 N 期变化的简单均值 */
function avgChange(obs, n = 3) {
  if (!obs || obs.length < n + 1) return null;
  let sum = 0;
  for (let i = obs.length - n; i < obs.length; i++) sum += obs[i][1] - obs[i - 1][1];
  return Math.round((sum / n) * 1000) / 1000;
}

// ---------- 主流程 ----------

async function main() {
  const args = process.argv.slice(2);
  const cmeOnly = args.includes('--cme-only');
  const fredOnly = args.includes('--fred-only');
  const dateArgIdx = args.indexOf('--date');
  const now = new Date();
  const today = sgtDate(now);

  log('');
  log('═══════════════════════════════════════════');
  log('  FOMC 看板 · 数据采集  ' + sgtStamp(now));
  log('═══════════════════════════════════════════');

  const cfg = readJson(path.join(CONFIG, 'series.json'));
  if (!cfg) { log('✗ 读不到 config/series.json'); process.exit(1); }

  ensureDir(path.join(DATA, 'raw'));
  ensureDir(path.join(DATA, 'snapshots', today));
  ensureDir(path.join(DATA, 'derived'));

  const report = { collectedAt: sgtStamp(now), date: today, cme: null, fred: null, errors: [] };

  // ---- CME ----
  if (!fredOnly) {
    log('');
    log('▸ [1/2] CME 30-Day Fed Funds Futures 结算价');
    let startDate = now;
    if (dateArgIdx >= 0 && args[dateArgIdx + 1]) {
      const [mm, dd, yyyy] = args[dateArgIdx + 1].split('/');
      startDate = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
    }
    try {
      const res = await fetchCmeCurve(cfg.cme.endpoint, cfg.cme.productId, startDate, cfg.cme.retentionDays);
      if (!res) {
        log('  ✗ 回溯 7 天均无数据（可能长期休市或接口变更）');
        report.errors.push('CME: 回溯窗口内无数据');
      } else {
        const curve = parseCurve(res.rows);
        const head = curve.slice(0, 4).map(x => `${x.month}=${x.impliedRate.toFixed(3)}%`).join('  ');
        log(`  ✓ 结算日 ${res.tradeDate}（更新于 ${res.updateTime}）`);
        log(`  ✓ 有效合约 ${curve.length} 个  |  ${head} ...`);

        const payload = {
          source: 'CME Group · 30 Day Federal Funds Futures (productId 305)',
          endpoint: cfg.cme.endpoint.replace('{productId}', cfg.cme.productId).replace('{MM/DD/YYYY}', res.tradeDate),
          tradeDate: res.tradeDate,
          updateTime: res.updateTime,
          fetchedAt: sgtStamp(now),
          formula: 'impliedRate = 100 - settle',
          contractCount: curve.length,
          curve,
        };
        writeJson(path.join(DATA, 'raw', 'cme-zq.json'), payload);
        // 日期化的永久留档（同一天重跑覆盖，不产生重复）
        const key = String(res.tradeDate).replace(/[\/]/g, '-');
        writeJson(path.join(DATA, 'snapshots', today, `cme-zq-${key}.json`), payload);
        report.cme = { tradeDate: res.tradeDate, contractCount: curve.length, front: curve[0]?.impliedRate ?? null };
      }
    } catch (e) {
      log('  ✗ 异常：' + e.message);
      report.errors.push('CME: ' + e.message);
    }
  }

  // ---- FRED ----
  if (!cmeOnly) {
    log('');
    log(`▸ [2/2] FRED 序列（${cfg.fred.length} 条，无 key）`);
    const results = [];
    for (const entry of cfg.fred) {
      try {
        const r = await fetchFredSeries(entry);
        results.push(r);
        if (r.ok) {
          log(`  ✓ ${r.key.padEnd(16)} ${String(r.latestDate).padEnd(11)} ${String(r.latestValue).padEnd(12)} (${r.count} 期)`);
        } else {
          log(`  ✗ ${r.key.padEnd(16)} 失败 HTTP ${r.status}`);
          report.errors.push(`FRED ${r.id}: HTTP ${r.status}`);
        }
      } catch (e) {
        log(`  ✗ ${entry.key.padEnd(16)} ${e.message}`);
        report.errors.push(`FRED ${entry.id}: ${e.message}`);
      }
    }

    // 只落盘最新一段，避免仓库膨胀（保留近 10 年）
    const cutoff = new Date(Date.now() - 10 * 365 * 86400000).toISOString().slice(0, 10);
    const trimmed = results.map(r => ({
      key: r.key, id: r.id, label: r.label, group: r.group, unit: r.unit,
      ok: r.ok, count: r.count, latestDate: r.latestDate, latestValue: r.latestValue,
      obs: (r.obs || []).filter(([d]) => d >= cutoff),
    }));

    writeJson(path.join(DATA, 'raw', 'fred.json'), {
      source: 'FRED (fredgraph.csv, no key)', fetchedAt: sgtStamp(now), series: trimmed,
    });
    writeJson(path.join(DATA, 'snapshots', today, 'fred.json'), {
      source: 'FRED (fredgraph.csv, no key)', fetchedAt: sgtStamp(now), series: trimmed,
    });
    report.fred = { total: results.length, ok: results.filter(r => r.ok).length };

    // ---- 派生 ----
    const byKey = Object.fromEntries(results.map(r => [r.key, r]));
    const derived = {
      generatedAt: sgtStamp(now),
      date: today,
      policy: {
        targetUpper: byKey.fedTargetUpper?.latestValue ?? null,
        targetLower: byKey.fedTargetLower?.latestValue ?? null,
        effr: byKey.effr?.latestValue ?? null,
        sofr: byKey.sofr?.latestValue ?? null,
        effrAsOf: byKey.effr?.latestDate ?? null,
      },
      inflation: {
        corePceIndex: byKey.corePce?.latestValue ?? null,
        corePceYoY: yoy(byKey.corePce?.obs),
        corePce3mAnn: annualized3m(byKey.corePce?.obs),
        cpiYoY: yoy(byKey.cpi?.obs),
        breakeven10y: byKey.t10yie?.latestValue ?? null,
      },
      labor: {
        unrate: byKey.unrate?.latestValue ?? null,
        payrolls3mAvg: avgChange(byKey.payrolls?.obs, 3),
        payrollsLatest: byKey.payrolls?.obs?.length ? byKey.payrolls.obs[byKey.payrolls.obs.length - 1][1] : null,
      },
      financial: {
        dgs10: byKey.dgs10?.latestValue ?? null,
        dgs2: byKey.dgs2?.latestValue ?? null,
        spread10y2y: byKey.t10y2y?.latestValue ?? null,
        real10y: byKey.dfii10?.latestValue ?? null,
        igSpread: byKey.igSpread?.latestValue ?? null,
        hySpread: byKey.hySpread?.latestValue ?? null,
        nfci: byKey.nfci?.latestValue ?? null,
        vix: byKey.vix?.latestValue ?? null,
      },
      liquidity: {
        reserves: byKey.reserves?.latestValue ?? null,
        rrp: byKey.rrp?.latestValue ?? null,
        tga: byKey.tga?.latestValue ?? null,
      },
      markets: {
        sp500: byKey.sp500?.latestValue ?? null,
        dxy: byKey.dxy?.latestValue ?? null,
        vix: byKey.vix?.latestValue ?? null,
      },
    };
    writeJson(path.join(DATA, 'derived', 'current.json'), derived);

    log('');
    log('▸ 派生指标');
    log(`  政策利率       ${derived.policy.targetLower}–${derived.policy.targetUpper}%   EFFR ${derived.policy.effr}%`);
    log(`  核心PCE 3M年化  ${derived.inflation.corePce3mAnn}%   同比 ${derived.inflation.corePceYoY}%`);
    log(`  失业率         ${derived.labor.unrate}%   非农3M均值 +${derived.labor.payrolls3mAvg}k/月`);
    log(`  曲线           2Y ${derived.financial.dgs2}% / 10Y ${derived.financial.dgs10}% (${derived.financial.spread10y2y})`);
  }

  // ---- 汇总 ----
  report.status = report.errors.length === 0 ? 'ok' : (report.cme || report.fred ? 'partial' : 'failed');
  writeJson(path.join(DATA, 'last-collect.json'), report);

  log('');
  log('───────────────────────────────────────────');
  log(`  状态: ${report.status.toUpperCase()}   错误: ${report.errors.length}`);
  if (report.errors.length) report.errors.forEach(e => log('   · ' + e));
  log('───────────────────────────────────────────');
  log('');
  return report.status === 'failed' ? 1 : 0;
}

main().then(code => process.exit(code)).catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
