/**
 * FOMC 看板 · L4 情景层计算器
 *
 * 输入：data/history/series.json（长历史资产序列）+ rate-events.json（政策利率台阶）
 *      config/scenarios.json（三轴情景定义）
 * 输出：data/derived/scenarios.json
 *
 * 方法：事件研究（event study）
 *   事件日 t0 = 目标利率生效日（DFEDTAR/DFEDTARU 探测，可复算）
 *   基准     = t0 前一交易日收盘（保证基准尚未反映新政）
 *   反应     = 第 n 个交易日后的值与基准之差（% / bp / 点）
 *   统计     = 组内中位数 + 四分位（中位数比均值稳健，避免单个极端事件主导）
 *
 * 三轴共用同一计算核心，区别只在「事件如何分组」：
 *   A 轴 按周期性质（预防式 / 正常化 / 追赶式）—— 人工语义标签
 *   B 轴 按单次加息幅度（25bp / ≥50bp / 降息）—— 自动
 *   C 轴 按所属周期的累计幅度（温和 / 中性 / 激进）—— 自动
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');
const CONFIG = path.join(ROOT, 'config');

const readJson = (p, fb = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const writeJson = (p, o) => { fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8'); };
const log = (...a) => console.log(...a);

/** 反应窗口（交易日） */
const WINDOWS = [
  { key: '1d', label: '1 日', n: 1 },
  { key: '10d', label: '10 日', n: 10 },
  { key: '1m', label: '1 月', n: 21 },
  { key: '3m', label: '3 月', n: 63 },
  { key: '6m', label: '6 月', n: 126 },
  { key: '1y', label: '1 年', n: 252 },
];

/** 现代货币政策框架起点。1985–1989 的碎步调整（6.25/12.5/43.75bp）幅度制式不同，排除。 */
const MODERN_FROM = '1994-01-01';

const r2 = x => Math.round(x * 100) / 100;

/** 标准正态 CDF（Abramowitz & Stegun 7.1.26 erf 近似，|误差| < 7.5e-8） */
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/** 二分：第一个 >= d 的索引 */
function lowerBound(dates, d) {
  let lo = 0, hi = dates.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (dates[mid] < d) lo = mid + 1; else hi = mid; }
  return lo;
}

/** 单个事件 → 单个资产 → n 个交易日后的反应 */
function reaction(dates, obs, eventDate, n, kind) {
  const i = lowerBound(dates, eventDate);
  if (i <= 0) return null;
  const b = i - 1;
  const t = b + n;
  if (t >= obs.length) return null;
  const base = obs[b], now = obs[t];
  if (!Number.isFinite(base) || !Number.isFinite(now) || base === 0) return null;
  if (kind === 'yield') return r2((now - base) * 100);   // bp
  if (kind === 'level') return r2(now - base);           // 点
  return r2((now / base - 1) * 100);                     // %
}

function quantile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function stats(values) {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return { n: v.length, med: r2(quantile(v, 0.5)), q1: r2(quantile(v, 0.25)), q3: r2(quantile(v, 0.75)) };
}

async function main() {
  log('');
  log('═══════════════════════════════════════════');
  log('  FOMC L4 情景层计算');
  log('═══════════════════════════════════════════');

  const hist = readJson(path.join(DATA, 'history', 'series.json'));
  const evFile = readJson(path.join(DATA, 'history', 'rate-events.json'));
  const cfg = readJson(path.join(CONFIG, 'scenarios.json'));
  if (!hist || !evFile || !cfg) { log('✗ 缺数据。先跑 collect-history.mjs'); process.exit(1); }

  // B 轴的「下一次决议」指针：从会议日历自动推导 —— 决议过后自动指向下一场，无需手改配置
  const meetFile = readJson(path.join(CONFIG, 'meetings.json'));
  const todaySGT = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const nextMeeting = (meetFile?.meetings || []).map(m => m.date).sort().find(d => d >= todaySGT) || null;

  // ---------- 1. 事件探测（升降都取） ----------
  const upper = evFile.upperSeries || [];
  const allEvents = [];
  for (let i = 1; i < upper.length; i++) {
    const delta = r2((upper[i][1] - upper[i - 1][1]) * 100);
    if (delta === 0) continue;
    allEvents.push({ date: upper[i][0], bp: delta, dir: delta > 0 ? 'up' : 'down', from: upper[i - 1][1], to: upper[i][1] });
  }

  const modern = allEvents.filter(e => e.date >= MODERN_FROM);
  const hikes = modern.filter(e => e.dir === 'up');
  const cuts = modern.filter(e => e.dir === 'down');

  // 幅度制式检查：现代框架下加息应为 25 的整数倍
  const odd = hikes.filter(e => Math.abs(e.bp) % 25 !== 0);
  if (odd.length) log(`  ⚠ 非 25bp 整数倍的加息 ${odd.length} 次：${odd.map(e => `${e.date}(${e.bp}bp)`).join(', ')}`);

  log('');
  log(`▸ 事件池（${MODERN_FROM} 起现代框架）`);
  log(`  加息 ${hikes.length} 次   降息 ${cuts.length} 次`);
  log(`  幅度分布：` + [...new Set(hikes.map(e => e.bp))].sort((a, b) => a - b).map(bp => `${bp}bp×${hikes.filter(e => e.bp === bp).length}`).join('  '));

  // ---------- 2. 事件打标签 ----------
  const cycles = cfg.cycles || [];
  const findCycle = d => cycles.find(c => c.start <= d && d <= c.end) || null;

  // 各历史周期的「起点 / 终点」目标区间上限 —— 用于 C 轴卡片亮出样本水平
  // （C 轴问的是水平、却按累计幅度分组；把样本水平摊开才能让口径差异可见）
  const upperSeries = evFile.upperSeries || [];
  const rateBefore = d => { let v = null; for (const [dt, r] of upperSeries) { if (dt < d) v = r; else break; } return v; };
  const rateAt = d => { let v = null; for (const [dt, r] of upperSeries) { if (dt <= d) v = r; else break; } return v; };
  const cycleLevel = id => {
    const c = cycles.find(x => x.id === id);
    if (!c) return null;
    return { id: c.id, label: c.label, totalBp: c.totalBp ?? null, from: rateBefore(c.start), to: rateAt(c.end) };
  };

  // 当前事件与历史样本分离
  const currentEventDate = evFile.events?.[evFile.events.length - 1]?.date;
  const tagged = hikes
    .filter(e => e.date !== currentEventDate)
    .map(e => {
      const cyc = findCycle(e.date);
      return { ...e, cycleId: cyc?.id || null, nature: cyc?.nature || null, cycleTotalBp: cyc?.totalBp ?? null };
    });

  const untagged = tagged.filter(e => !e.cycleId);
  if (untagged.length) log(`  ⚠ 未归入任何周期的加息事件 ${untagged.length} 次：${untagged.map(e => e.date).join(', ')}`);

  log('');
  log('▸ 样本分组');
  for (const c of cycles) {
    const n = tagged.filter(e => e.cycleId === c.id).length;
    // totalBp 可为 null（进行中的周期，终点未定）→ 不能直接 String(null)
    const bpTxt = c.totalBp == null ? '  +?bp' : `+${String(c.totalBp).padStart(3)}bp`;
    const natTxt = (c.nature || '—').padEnd(15);
    const openMark = (c.end && c.end > new Date().toISOString().slice(0, 10)) ? '（进行中）' : '';
    log(`  ${c.id.padEnd(11)} ${natTxt} ${bpTxt}  样本 ${String(n).padStart(2)} 次${openMark}`);
  }

  // ---------- 3. 计算反应矩阵 ----------
  const assets = Object.values(hist.series).map(s => ({
    key: s.key, label: s.label, kind: s.kind, unit: s.unit, group: s.group, source: s.source,
    from: s.obs[0][0], to: s.obs[s.obs.length - 1][0],
  }));
  const prepared = {};
  for (const [k, s] of Object.entries(hist.series)) {
    prepared[k] = { dates: s.obs.map(o => o[0]), vals: s.obs.map(o => o[1]), kind: s.kind };
  }

  /** 一组事件 → 全资产 × 全窗口 的反应统计 */
  function computeGroup(events) {
    const matrix = {};
    for (const a of assets) {
      const p = prepared[a.key];
      if (!p) continue;
      const row = {};
      for (const w of WINDOWS) {
        const vals = events.map(e => reaction(p.dates, p.vals, e.date, w.n, p.kind)).filter(v => v !== null);
        const st = stats(vals);
        if (st) row[w.key] = st;
      }
      if (Object.keys(row).length) matrix[a.key] = row;
    }
    return matrix;
  }

  /** 单个事件的逐窗口反应（用于展示逐个样本 + 当前事件实测） */
  function computeEvent(e) {
    const out = { date: e.date, bp: e.bp, dir: e.dir, cycleId: e.cycleId || null, nature: e.nature || null, cycleTotalBp: e.cycleTotalBp ?? null, matrix: {} };
    for (const a of assets) {
      const p = prepared[a.key];
      if (!p) continue;
      const row = {};
      for (const w of WINDOWS) {
        const v = reaction(p.dates, p.vals, e.date, w.n, p.kind);
        if (v !== null) row[w.key] = v;
      }
      if (Object.keys(row).length) out.matrix[a.key] = row;
    }
    return out;
  }

  // ---------- A 轴 ----------
  const axisA = { ...cfg.axisA, groups: cfg.axisA.groups.map(g => {
    const evs = tagged.filter(e => e.nature === g.key);
    return { id: g.id, key: g.key, name: g.name, probability: g.probability, definition: g.definition,
             cycles: g.cycles, triggers: g.triggers, verdict: g.verdict,
             n: evs.length, eventDates: evs.map(e => e.date), matrix: computeGroup(evs) };
  }) };

  /* ── 概率解析：B / C 轴改为数据驱动（2026-11-12 用户拍板）──────────────
     旧逻辑的病：config 里的概率是人工快照，market-implied 只用来打「偏离 >10pp」告警。
     于是 11-07 写下的 B1=77% 一路显示到 11-11，市场已经 100%，看板静默落后两天。
     新口径：B 轴＝隐含路径直接反推（(会后中点−EFFR)/25bp），C 轴＝隐含终点按 σ 正态分摊。
     两者都能从 market-implied.json 复算，就应该以数据为准覆盖 config；
     config 值保留在 configProbability 里供追溯，不再参与展示。
     A 轴仍是主观判断（周期性质、触发条件满足度），市场没有对应量，不覆盖。 */
  const MI = readJson(path.join(DATA, 'derived', 'market-implied.json'));
  const miStale = !MI ? '缺 data/derived/market-implied.json'
    : !MI.nextMeeting ? 'market-implied.json 里没有 nextMeeting'
    : MI.nextMeeting.decision !== nextMeeting
      ? `记录的是 ${MI.nextMeeting.decision}，与会议日历 ${nextMeeting} 不一致（先重跑 market-implied.mjs）`
      : null;

  /** B 轴：期货按 25bp 步长定价，故 hike50 / cut 没有独立信息，记 0 */
  const impliedB = (() => {
    if (miStale) return null;
    const p = MI.nextMeeting.p25;
    if (!Number.isFinite(p)) return null;
    const q = Math.max(0, Math.min(1, p));
    return { hike25: q, hike50: 0, hold: 1 - q, cut: 0 };
  })();

  /** C 轴：隐含终点（bp-to-go）为均值，σ 正态核分摊到三段 */
  const impliedC = (() => {
    const pp = cfg._probabilityBasis?.axisC_params;
    if (!MI?.terminal || !Array.isArray(pp?.boundariesBp) || !Number.isFinite(pp?.sigmaPp)) return null;
    if (!Number.isFinite(MI.terminal.addBp)) return null;
    const mu = MI.terminal.addBp;
    const sd = pp.sigmaPp * 100;
    const [b1, b2] = pp.boundariesBp;
    const c1 = normCdf((b1 - mu) / sd);
    const c2 = normCdf((b2 - mu) / sd) - c1;
    return { C1: c1, C2: c2, C3: 1 - normCdf((b2 - mu) / sd) };
  })();

  /** 取概率：数据可用就用数据，否则回退 config 并留下 source 标记 */
  const pickProb = (g, implied) => {
    const v = implied ? implied[g.key || g.id] : undefined;
    const driven = Number.isFinite(v);
    return {
      probability: driven ? v : g.probability,
      configProbability: g.probability,
      probabilitySource: driven ? 'market-implied' : 'config',
    };
  };

  log('');
  log('▸ 概率来源（B / C 轴数据驱动）');
  if (miStale) {
    log(`  ⚠ ${miStale}`);
    log('  → B / C 轴回退到 config 值，看板会标注「配置」；请修好数据后重跑');
  } else {
    const b1cfg = (cfg.axisB.groups.find(g => g.key === 'hike25') || {}).probability;
    log(`  B 轴：市场隐含 P(25bp) = ${(impliedB.hike25 * 100).toFixed(0)}% ｜ config ${((b1cfg || 0) * 100).toFixed(0)}% → 采用市场值`);
    if (impliedC) {
      const ccfg = (cfg.axisC.groups.find(g => g.id === 'C1') || {}).probability;
      log(`  C 轴：隐含终点 ${MI.terminal.upperBasis}%（再加 ${MI.terminal.addBp}bp，σ=${cfg._probabilityBasis.axisC_params.sigmaPp}pp）→ C1 ${(impliedC.C1 * 100).toFixed(0)}% ｜ config ${((ccfg || 0) * 100).toFixed(0)}%`);
    } else {
      log('  C 轴：缺 terminal 或 axisC_params → 回退 config');
    }
  }

  // ---------- B 轴 ----------
  const axisB = { ...cfg.axisB,
    // {next} 由会议日历填入；决议过后自动跟随到下一场（原先是手写死日期，会过期）
    question: String(cfg.axisB.question || '').replace(/\{next\}/g, nextMeeting || '待定'),
    nextMeeting,
    probabilitySource: impliedB ? 'market-implied' : 'config',
    marketImpliedP25: impliedB ? impliedB.hike25 : null,
    groups: cfg.axisB.groups.map(g => {
    let evs = [];
    if (g.key === 'hike25') evs = tagged.filter(e => e.bp === 25);
    else if (g.key === 'hike50') evs = tagged.filter(e => e.bp >= 50);
    else if (g.key === 'cut') evs = cuts.filter(e => e.date >= MODERN_FROM);
    const excluded = g.matrixExcluded === true;
    return { id: g.id, key: g.key, name: g.name, ...pickProb(g, impliedB), analogy: g.analogy, filter: g.filter,
             n: evs.length, matrixExcluded: excluded, matrixExcludeReason: g.matrixExcludeReason || null,
             eventDates: evs.map(e => e.date), matrix: (!excluded && evs.length) ? computeGroup(evs) : {} };
  }) };

  // ---------- C 轴 ----------
  const axisC = { ...cfg.axisC,
    probabilitySource: impliedC ? 'market-implied' : 'config',
    marketImpliedTerminalBp: impliedC ? MI.terminal.addBp : null,
    groups: cfg.axisC.groups.map(g => {
    const evs = tagged.filter(e => e.cycleTotalBp !== null && matchesRange(e.cycleTotalBp, g.filter));
    return { id: g.id, key: g.key, name: g.name, ...pickProb(g, impliedC), definition: g.definition,
             cycles: g.cycles, trigger: g.trigger, filter: g.filter,
             sampleLevels: (g.cycles || []).map(cycleLevel).filter(Boolean),
             n: evs.length, eventDates: evs.map(e => e.date), matrix: computeGroup(evs) };
  }) };

  function matchesRange(v, f) {
    if (!f) return false;
    if (f.minTotalBp !== undefined && v < f.minTotalBp) return false;
    if (f.maxTotalBp !== undefined && v > f.maxTotalBp) return false;
    return true;
  }

  // ---------- 当前事件实测 ----------
  const curEv = hikes.find(e => e.date === currentEventDate);
  const currentReaction = curEv ? computeEvent({ ...curEv, cycleId: null, nature: null, cycleTotalBp: null }) : null;

  // ---------- 输出 ----------
  const out = {
    generatedAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00'),
    method: {
      eventDay: '目标利率生效日（FRED DFEDTAR / DFEDTARU 自动探测）',
      baseline: '事件日前一交易日收盘',
      windows: WINDOWS,
      statistic: '组内中位数 + 四分位（n 为该格有效样本数）',
      modernFrom: MODERN_FROM,
      exclusion: '1985–1989 年碎步调整（6.25/12.5/43.75bp）已排除：幅度制式与 1994 年后的 25bp 框架不可比',
    },
    current: cfg.current,
    windowKeys: WINDOWS.map(w => w.key),
    assets,
    totalHikes: tagged.length,
    axisA, axisB, axisC,
    currentReaction,
  };

  writeJson(path.join(DATA, 'derived', 'scenarios.json'), out);

  log('');
  log('▸ 反应矩阵抽样（A 轴 · 标普 500，中位数）');
  for (const g of axisA.groups) {
    const row = g.matrix.sp500 || {};
    const cells = WINDOWS.map(w => row[w.key] ? `${String(row[w.key].med).padStart(6)}%` : '     —');
    log(`  ${g.id} ${g.name.padEnd(5)} n=${String(g.n).padStart(2)}  ${cells.join(' ')}`);
  }
  log('');
  log('▸ 当前事件实测（' + (curEv ? curEv.date + '  +' + curEv.bp + 'bp' : '无') + '）');
  if (currentReaction) {
    for (const a of assets.slice(0, 6)) {
      const row = currentReaction.matrix[a.key] || {};
      const cells = WINDOWS.map(w => row[w.key] !== undefined ? `${String(row[w.key]).padStart(7)}` : '      —');
      log(`  ${a.label.padEnd(13)} ${cells.join(' ')}  ${a.unit}`);
    }
  }

  const size = fs.statSync(path.join(DATA, 'derived', 'scenarios.json')).size;
  log('');
  log('───────────────────────────────────────────');
  log(`  ✓ data/derived/scenarios.json（${(size / 1024).toFixed(1)} KB）`);
  log(`  历史加息样本 ${tagged.length} 次 · 资产 ${assets.length} 个 · 窗口 ${WINDOWS.length} 档`);
  log('───────────────────────────────────────────');
  log('');
}

export { main };

// 仅在被直接执行时自运行；被 import 时由调用方 await main()
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('FATAL', e); process.exit(1); });
}
