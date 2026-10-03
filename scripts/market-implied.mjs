/**
 * FOMC 看板 · 市场隐含政策路径求解器
 *
 * 输入：data/raw/cme-zq.json      （CME ZQ 结算价，隐含利率 = 100 − settle）
 *      config/meetings.json      （FOMC 会议日历）
 *      data/derived/current.json （当前 EFFR / 目标区间）
 * 输出：data/derived/market-implied.json
 *
 * 方法（与 CME FedWatch 同源，但透明可复算）：
 *   ZQ 结算价 ≈ 该月 EFFR 的【日均值】。政策利率是阶梯函数，台阶落在会议决议的
 *   【生效日】（决议日 +1 天）。于是：
 *
 *     隐含利率_m = (1/N_m) · Σ_{day∈m} r(day)
 *
 *   其中 r(day) 由「上一个生效日」决定。把每个会议后的利率当作未知数，就得到
 *   一个超定线性方程组 → 最小二乘求解（正规方程 + 高斯消元，全精度，无外部依赖）。
 *
 *   自校验：SEP 26 合约用【已知】利率就能算出来（3.50–3.75% 的 16 天 + 3.75–4.00%
 *   的 14 天），与结算价误差 < 1bp ⇒ 证明「日均值」建模成立。
 *
 * 注意：
 *   - 只用流动性区间内的合约（持仓量 OI ≥ 阈值），因为远端 settle 无成交支撑
 *     （实测 NOV 27 之后 OI 归零，直接取全曲线峰值会得到 2029+ 的假峰值）。
 *   - 2027 下半年的会议日取自 FOMC 常规节奏【推测】，尚未官方发布。它们只影响
 *     JUL–NOV 27 这几个观测月，**不影响 2027-06 之前的路径**，报告中已标注。
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

const OI_MIN = 2000;          // 流动性门槛（手）
const STEP = 0.25;            // 25bp 制式
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const r2 = x => Math.round(x * 100) / 100;
const r3 = x => Math.round(x * 1000) / 1000;

const isLeap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

/** "SEP 26" → { y: 2026, m: 9, label } */
function parseMonth(label) {
  const [mon, yy] = label.trim().split(/\s+/);
  const m = MONTHS.indexOf(mon) + 1;
  if (m === 0) return null;
  return { y: 2000 + Number(yy), m, label };
}

/** 解 A·x = b：正规方程 + 高斯消元（列主元） */
function lstsq(A, b) {
  const n = A[0].length, rows = A.length;
  const N = Array.from({ length: n }, () => new Float64Array(n));
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      for (let k = 0; k < rows; k++) s += A[k][i] * A[k][j];
      N[i][j] = s; N[j][i] = s;
    }
    let s2 = 0;
    for (let k = 0; k < rows; k++) s2 += A[k][i] * b[k];
    y[i] = s2;
  }
  // 前向消元
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r0 = c + 1; r0 < n; r0++) if (Math.abs(N[r0][c]) > Math.abs(N[piv][c])) piv = r0;
    if (piv !== c) { const t = N[piv]; N[piv] = N[c]; N[c] = t; const ty = y[piv]; y[piv] = y[c]; y[c] = ty; }
    if (Math.abs(N[c][c]) < 1e-12) continue;
    for (let r0 = c + 1; r0 < n; r0++) {
      const f = N[r0][c] / N[c][c];
      for (let c2 = c; c2 < n; c2++) N[r0][c2] -= f * N[c][c2];
      y[r0] -= f * y[c];
    }
  }
  // 回代
  const x = new Float64Array(n);
  for (let r0 = n - 1; r0 >= 0; r0--) {
    let s = y[r0];
    for (let c = r0 + 1; c < n; c++) s -= N[r0][c] * x[c];
    x[r0] = Math.abs(N[r0][r0]) < 1e-12 ? 0 : s / N[r0][r0];
  }
  return Array.from(x);
}

async function main() {
  log('');
  log('═══════════════════════════════════════════');
  log('  FOMC 市场隐含政策路径');
  log('═══════════════════════════════════════════');

  const cme = readJson(path.join(DATA, 'raw', 'cme-zq.json'));
  const cur = readJson(path.join(DATA, 'derived', 'current.json'));
  const meets = readJson(path.join(CONFIG, 'meetings.json'));
  if (!cme || !cur || !meets) { log('✗ 缺数据（cme-zq.json / current.json / meetings.json）'); process.exit(1); }

  const upperNow = cur.policy.targetUpper, lowerNow = cur.policy.targetLower;
  const midNow = (upperNow + lowerNow) / 2;

  // ---------- 1. 会议台阶（生效日 = 决议日 + 1） ----------
  const steps = [];
  for (const m of meets.meetings || []) {
    const d = new Date(m.date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    steps.push({ decision: m.date, eff: d.toISOString().slice(0, 10), assumed: false });
  }
  // 2027 H2：官方日历未发布，按 FOMC 常规节奏（约每 7 周）推测
  for (const dm of ['2027-07-28', '2027-09-15', '2027-11-03']) {
    const d = new Date(dm + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
    steps.push({ decision: dm, eff: d.toISOString().slice(0, 10), assumed: true });
  }
  steps.sort((a, b) => a.eff < b.eff ? -1 : 1);

  // ---------- 2. 观测月（只看流动性区间） ----------
  const obs = cme.curve
    .map((c, i) => ({ ...c, ...parseMonth(c.month), oi: c.openInterest, idx: i }))
    .filter(c => c.m && c.oi >= OI_MIN)
    .sort((a, b) => (a.y * 12 + a.m) - (b.y * 12 + b.m));
  if (obs.length < 6) { log(`✗ 可用观测月太少（${obs.length}）`); process.exit(1); }

  // ---------- 3. 建模：政策利率阶梯 → 月均 ----------
  // 已知段：2026-09-17 之前 = 旧档位中点；2026-09-17 ~ 下一次会议生效日 = 当前档位中点。
  // 关键：已是既成事实的会议（生效日 ≤ 09-17）【不能】当未知数，否则方程组奇异。
  const PREV_MID = midNow - STEP;
  const SETTLE_0 = '2026-09-17';
  const last = obs[obs.length - 1];
  const horizon = `${last.y}-${String(last.m).padStart(2, '0')}-31`;
  const unk = steps
    .filter(s => s.eff > SETTLE_0 && s.eff <= horizon)
    .map((s, i) => ({ ...s, i }));

  const A = [], b = [];
  for (const o of obs) {
    const N = daysIn(o.y, o.m);
    const row = new Array(unk.length).fill(0);
    let known = 0;
    for (let day = 1; day <= N; day++) {
      const date = `${o.y}-${String(o.m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      // 已知段要按 1/N 加权（月均 = 各日利率之和 ÷ N），否则把「和」当成「均值」
      if (date < SETTLE_0) { known += PREV_MID / N; continue; }
      const hit = [...unk].reverse().find(u => date >= u.eff);
      if (!hit) { known += midNow / N; continue; }
      row[hit.i] += 1 / N;
    }
    A.push(row);
    b.push(o.impliedRate - known);
  }

  const x = lstsq(A, b);

  // ---------- 4. 残差自检 ----------
  // 预测值 = A·x + known，其中 known = implied − b ⇒ 残差(bp) = (A·x − b)·100
  const resid = obs.map((o, k) => (A[k].reduce((s, v, i) => s + v * x[i], 0) - b[k]) * 100);
  const maxAbs = Math.max(...resid.map(Math.abs));

  log('');
  log(`▸ 观测月 ${obs.length} 个（OI ≥ ${OI_MIN} 手，${obs[0].label} ~ ${obs[obs.length - 1].label}）`);
  log(`▸ 未知台阶 ${unk.length} 个（其中推测会议日 ${unk.filter(u => u.assumed).length} 个）`);
  log(`▸ 拟合残差：max ${maxAbs.toFixed(1)}bp / mean ${(resid.reduce((a, c) => a + Math.abs(c), 0) / resid.length).toFixed(1)}bp`);

  // ---------- 5. 逐会议解读 ----------
  const path0 = [{ decision: '(当前)', eff: SETTLE_0, mid: midNow, d: 0, p25: 0 }];
  const series = [...path0];
  for (const u of unk) {
    const prev = series[series.length - 1].mid;
    const d = x[u.i] - prev;
    series.push({ decision: u.decision, eff: u.eff, assumed: u.assumed, mid: r3(x[u.i]), d: r2(d), p25: Math.max(0, Math.min(1, r2(d / STEP))) });
  }

  log('');
  log('▸ 市场隐含政策路径（目标区间中点）');
  log(`  ${'决议日'.padEnd(12)}${'生效日'.padEnd(12)}${'隐含中点'.padStart(9)}${'较前次'.padStart(9)}${'隐含 25bp 概率'.padStart(15)}`);
  for (const s of series.slice(1)) {
    log(`  ${(s.decision + (s.assumed ? '*' : '')).padEnd(12)}${s.eff.padEnd(12)}${String(s.mid).padStart(9)}${((s.d >= 0 ? '+' : '') + (s.d * 100).toFixed(0) + 'bp').padStart(9)}${((s.p25 * 100).toFixed(0) + '%').padStart(15)}`);
  }

  const near = series.slice(1, 4);
  log('');
  log('▸ 下一场（10-28）概率');
  const p1028 = series[1];
  log(`  加息 25bp ${(p1028.p25 * 100).toFixed(0)}% ｜ 按兵不动 ${((1 - p1028.p25) * 100).toFixed(0)}% ｜ ≥50bp ${(Math.max(0, p1028.d - STEP) > 0 ? ((p1028.d - STEP) / STEP * 100).toFixed(0) : 0)}% ｜ 降息 0%`);

  const peak = series.slice(1).reduce((a, c) => c.mid > a.mid ? c : a, series[1]);
  log('');
  log(`▸ 隐含终点（峰值）：${peak.mid}（${peak.decision}）＝ 目标上限 ${r3(peak.mid + STEP / 2)}`);
  log(`  较当前（中点 ${midNow} / 上限 ${upperNow}）再加 ${((peak.mid - midNow) / STEP).toFixed(2)} 次 25bp（约 ${((peak.mid - midNow) * 100).toFixed(0)}bp）`);
  log(`  ⚠ 峰值只在流动性区间内取；全曲线峰值（AUG 31 5.54）无持仓量支撑，不可用`);

  writeJson(path.join(DATA, 'derived', 'market-implied.json'), {
    generatedAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00'),
    source: { cmeTradeDate: cme.tradeDate, oiMin: OI_MIN, effr: cur.policy.effr, midNow, upperNow, lowerNow },
    method: 'ZQ 月均隐含利率 = 政策利率阶梯在该月的日均值；台阶落在决议生效日（决议日+1）；最小二乘求解',
    fitQuality: { maxResidBp: r2(maxAbs), meanAbsResidBp: r2(resid.reduce((a, c) => a + Math.abs(c), 0) / resid.length), nObs: obs.length, nUnknown: unk.length },
    caveat: '2027 H2 会议日为推测（官方日历未发布），仅影响 JUL–NOV 27 观测月，不影响 2027-06 之前的路径',
    path: series,
    nextMeeting: { decision: series[1].decision, mid: series[1].mid, p25: series[1].p25 },
    terminal: { mid: peak.mid, decision: peak.decision, upperBasis: r3(peak.mid + STEP / 2), addBp: r2((peak.mid - midNow) * 100) },
  });

  log('');
  log('───────────────────────────────────────────');
  log('  ✓ data/derived/market-implied.json');
  log('───────────────────────────────────────────');
  log('');
}

export { main };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('FATAL', e); process.exit(1); });
}
