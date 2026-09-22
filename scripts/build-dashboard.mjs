/**
 * FOMC 看板 · 核心图构建器
 *
 * 产出 docs/index.html：市场隐含路径 vs 美联储 SEP vs 历史路径
 * 涨红跌绿（利率上行标红，符合中国习惯）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');
const DOCS = path.join(ROOT, 'docs');

const readJson = (p, fb = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };

/** "SEP 26" → {y:2026, m:9} */
function parseMonth(label) {
  const [mon, yy] = String(label).trim().split(/\s+/);
  const months = { JAN:1, FEB:2, MAR:3, APR:4, MAY:5, JUN:6, JUL:7, AUG:8, SEP:9, OCT:10, NOV:11, DEC:12 };
  const m = months[(mon || '').toUpperCase()];
  const y = 2000 + Number(yy);
  if (!m || !Number.isFinite(y)) return null;
  return { y, m, key: `${y}-${String(m).padStart(2, '0')}` };
}

/** 美联储 SEP 中值轨迹（人工维护，来源为官方 SEP PDF） */
function sepPath() {
  return [
    { date: '2026-09', rate: 4.10, label: '2026 年末' },
    { date: '2027-12', rate: 3.80, label: '2027 年末' },
    { date: '2028-12', rate: 3.40, label: '2028 年末' },
    { date: '2029-12', rate: 3.10, label: '长期' },
  ];
}

function build() {
  const cme = readJson(path.join(DATA, 'raw', 'cme-zq.json'));
  const derived = readJson(path.join(DATA, 'derived', 'current.json'));
  const meetings = readJson(path.join(ROOT, 'config', 'meetings.json'));

  if (!cme || !derived) { console.error('缺少数据，先跑 collect.mjs'); process.exit(1); }

  // 市场隐含路径：每月合约的隐含利率
  const market = cme.curve
    .map(c => ({ ...parseMonth(c.month), rate: c.impliedRate, oi: c.openInterest }))
    .filter(x => x && x.key)
    .filter(x => x.oi > 0) // 只保留有持仓的合约，远月无成交价格不可信
    .sort((a, b) => a.key.localeCompare(b.key));

  const sep = sepPath();

  const latest = meetings.decisions[meetings.decisions.length - 1];
  const nextMeeting = meetings.meetings.find(m => m.date > '2026-09-16');
  const today = derived.date;

  const html = render({ market, sep, derived, cme, latest, nextMeeting, today, meetings });

  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(path.join(DOCS, 'index.html'), html, 'utf8');
  console.log(`✓ docs/index.html 已生成（市场 ${market.length} 点 / SEP ${sep.length} 点）`);
}

function render({ market, sep, derived, cme, latest, nextMeeting, today, meetings }) {
  const P = derived.policy, I = derived.inflation, L = derived.labor, F = derived.financial;
  const liquidity = derived.liquidity;

  const maxRate = Math.max(...market.map(m => m.rate), ...sep.map(s => s.rate));
  const minRate = Math.min(...market.map(m => m.rate), ...sep.map(s => s.rate));
  const pad = 0.25;
  const yMax = maxRate + pad, yMin = minRate - pad;

  // SVG 尺寸
  const W = 900, H = 400, ML = 62, MR = 30, MT = 30, MB = 52;
  const plotW = W - ML - MR, plotH = H - MT - MB;

  const xs = [...market.map(m => m.key), ...sep.map(s => s.date)].sort();
  const xMin = xs[0], xMax = xs[xs.length - 1];

  // 时间轴按月份序号线性映射
  const toMonthNum = k => { const [y, m] = k.split('-').map(Number); return y * 12 + m; };
  const x0 = toMonthNum(xMin), x1 = toMonthNum(xMax);
  const px = k => ML + ((toMonthNum(k) - x0) / (x1 - x0)) * plotW;
  const py = r => MT + (1 - (r - yMin) / (yMax - yMin)) * plotH;

  const pathOf = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${px(p.k).toFixed(1)} ${py(p.r).toFixed(1)}`).join(' ');

  const marketPts = market.map(m => ({ k: m.key, r: m.rate }));
  const sepPts = sep.map(s => ({ k: s.date, r: s.rate }));

  // Y 轴刻度
  const yTicks = [];
  const step = yMax - yMin > 1.2 ? 0.25 : 0.125;
  for (let v = Math.ceil(yMin / step) * step; v <= yMax + 1e-9; v = Math.round((v + step) * 1000) / 1000) yTicks.push(v);

  // X 轴刻度：每 3 个月
  const xTicks = [];
  for (let n = Math.ceil(x0 / 3) * 3; n <= x1; n += 3) {
    const y = Math.floor(n / 12), m = n % 12 === 0 ? 12 : n % 12;
    xTicks.push(`${y}-${String(m).padStart(2, '0')}`);
  }

  const rateColor = v => v > 0 ? '#A32D2D' : '#0F6E56'; // 涨红跌绿

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FOMC 前瞻看板 · ${today}</title>
<style>
:root{
  --bg:#12100E; --panel:#1B1917; --panel2:#221F1C; --line:#33302C;
  --tx:#EDEAE6; --tx2:#A8A29A; --tx3:#6F6A63;
  --red:#E24B4A; --green:#639922; --blue:#378ADD; --amber:#EF9F27; --purple:#7F77DD;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
     font-size:14px;line-height:1.6;padding:28px 22px 60px;max-width:1100px;margin:0 auto}
h1{font-size:20px;font-weight:500;letter-spacing:.3px}
h2{font-size:15px;font-weight:500;margin:32px 0 14px;padding-left:10px;border-left:3px solid var(--amber);letter-spacing:.2px}
.sub{color:var(--tx2);font-size:13px;margin-top:6px}
.badge{display:inline-block;padding:2px 9px;border-radius:20px;font-size:12px;margin-right:8px;
       border:1px solid var(--line);color:var(--tx2)}
.badge.ok{border-color:#3B6D11;color:#97C459;background:rgba(99,153,34,.1)}
.badge.warn{border-color:#854F0B;color:#EF9F27;background:rgba(239,159,39,.1)}
.grid{display:grid;gap:12px}
.g4{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
.g3{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card .k{font-size:12px;color:var(--tx3);letter-spacing:.3px}
.card .v{font-size:22px;font-weight:500;margin:6px 0 2px;font-variant-numeric:tabular-nums}
.card .d{font-size:12px;color:var(--tx2)}
.up{color:var(--red)}.down{color:var(--green)}.flat{color:var(--tx2)}
table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
th,td{padding:9px 10px;text-align:left;border-bottom:1px solid var(--line)}
th{color:var(--tx3);font-weight:400;font-size:12px;letter-spacing:.3px}
td.n,th.n{text-align:right}
tr:last-child td{border-bottom:none}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:6px 4px;overflow-x:auto}
.legend{display:flex;gap:20px;flex-wrap:wrap;font-size:12px;color:var(--tx2);margin:12px 0 0;padding-left:4px}
.legend i{display:inline-block;width:16px;height:0;border-top-width:2px;border-top-style:solid;vertical-align:middle;margin-right:6px}
.note{font-size:12px;color:var(--tx3);margin-top:10px;line-height:1.7}
footer{margin-top:44px;padding-top:16px;border-top:1px solid var(--line);font-size:12px;color:var(--tx3);line-height:1.8}
</style>
</head>
<body>

<h1>FOMC 利率决议前瞻看板</h1>
<div class="sub">
  <span class="badge ok">数据 ${today}</span>
  <span class="badge">期货结算日 ${cme.tradeDate}</span>
  <span class="badge">下一场会议 ${nextMeeting ? nextMeeting.date : '—'}</span>
</div>

<h2>一、政策位置</h2>
<div class="grid g4">
  <div class="card"><div class="k">联邦基金目标区间</div>
    <div class="v">${P.targetLower}–${P.targetUpper}<span style="font-size:14px;color:var(--tx2)">%</span></div>
    <div class="d">上次决议 ${latest.date}：${latest.action === 'hike25' ? '加息 25bp' : latest.action === 'cut25' ? '降息 25bp' : '按兵不动'}</div></div>
  <div class="card"><div class="k">EFFR 有效利率</div>
    <div class="v">${P.effr}<span style="font-size:14px;color:var(--tx2)">%</span></div>
    <div class="d">截至 ${P.effrAsOf}</div></div>
  <div class="card"><div class="k">核心 PCE 3M 年化</div>
    <div class="v ${I.corePce3mAnn > 3 ? 'up' : I.corePce3mAnn > 2 ? 'flat' : 'down'}">${I.corePce3mAnn}<span style="font-size:14px;color:var(--tx2)">%</span></div>
    <div class="d">同比 ${I.corePceYoY}% · 目标 2%</div></div>
  <div class="card"><div class="k">失业率</div>
    <div class="v">${L.unrate}<span style="font-size:14px;color:var(--tx2)">%</span></div>
    <div class="d">非农 3M 均值 ${L.payrolls3mAvg > 0 ? '+' : ''}${L.payrolls3mAvg}k/月</div></div>
</div>

<h2>二、核心图：市场路径 vs 美联储路径</h2>
<div class="panel">
<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;min-width:760px">
  ${yTicks.map(v => `
  <line x1="${ML}" y1="${py(v).toFixed(1)}" x2="${W - MR}" y2="${py(v).toFixed(1)}" stroke="#2A2724" stroke-width="1"/>
  <text x="${ML - 8}" y="${(py(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#6F6A63">${v.toFixed(2)}</text>`).join('')}
  ${xTicks.map(k => `
  <line x1="${px(k).toFixed(1)}" y1="${MT}" x2="${px(k).toFixed(1)}" y2="${H - MB}" stroke="#211F1C" stroke-width="1"/>
  <text x="${px(k).toFixed(1)}" y="${H - MB + 18}" text-anchor="middle" font-size="11" fill="#6F6A63">${k.slice(2)}</text>`).join('')}

  <line x1="${ML}" y1="${H - MB}" x2="${W - MR}" y2="${H - MB}" stroke="#4A4640" stroke-width="1"/>
  <line x1="${ML}" y1="${MT}" x2="${ML}" y2="${H - MB}" stroke="#4A4640" stroke-width="1"/>

  <path d="${pathOf(sepPts)}" fill="none" stroke="#7F77DD" stroke-width="2" stroke-dasharray="7 4"/>
  ${sepPts.map(p => `<circle cx="${px(p.k).toFixed(1)}" cy="${py(p.r).toFixed(1)}" r="4" fill="#7F77DD"/>`).join('')}

  <path d="${pathOf(marketPts)}" fill="none" stroke="#378ADD" stroke-width="2.5"/>

  ${marketPts.map((p, i) => {
    if (i === 0 || i === marketPts.length - 1) return '';
    const prev = marketPts[i - 1], next = marketPts[i + 1];
    const isPeak = p.r > prev.r && p.r > next.r;
    const isTrough = p.r < prev.r && p.r < next.r;
    if (!isPeak && !isTrough) return '';
    const c = isPeak ? '#E24B4A' : '#639922';
    const tag = isPeak ? '市场预期利率峰值' : '市场预期利率低点';
    return `<circle cx="${px(p.k).toFixed(1)}" cy="${py(p.r).toFixed(1)}" r="5" fill="${c}" stroke="#12100E" stroke-width="2"/>
    <text x="${px(p.k).toFixed(1)}" y="${(py(p.r) - 13).toFixed(1)}" text-anchor="middle" font-size="11" fill="${c}">${tag} ${p.r.toFixed(3)}%</text>`;
  }).join('')}

  <text x="${(px(marketPts[0].k) + 6).toFixed(1)}" y="${(py(marketPts[0].r) - 10).toFixed(1)}" font-size="11" fill="#378ADD">近月 ${marketPts[0].r.toFixed(3)}%</text>
  <text x="${ML + 10}" y="${MT + 14}" font-size="11" fill="#6F6A63">隐含联邦基金利率（%）</text>
</svg>
</div>
<div class="legend">
  <span><i style="border-color:#378ADD"></i>市场隐含路径（CME 期货反算，${market.length} 个合约）</span>
  <span><i style="border-color:#7F77DD;border-top-style:dashed"></i>美联储 SEP 中值（人工补录）</span>
  <span><i style="border-color:#E24B4A"></i>隐含峰值</span>
</div>
<div class="note">
  横轴为合约到期月（YY-MM），纵轴为隐含联邦基金利率。市场路径仅保留有持仓（OI&gt;0）的合约，远月无成交者价格不可信已剔除。
  反算公式：<code>隐含利率 = 100 − settle</code>。利率上行以红色标示（涨红跌绿）。
</div>

<h2>三、市场路径明细</h2>
<div class="panel">
<table>
<thead><tr><th>合约</th><th class="n">结算价</th><th class="n">隐含利率</th><th class="n">较上月</th><th class="n">持仓量</th></tr></thead>
<tbody>
${market.slice(0, 16).map((m, i) => {
  const prev = i > 0 ? market[i - 1].rate : null;
  const delta = prev !== null ? (m.rate - prev) * 100 : null;
  return `<tr>
  <td>${m.y}-${String(m.m).padStart(2, '0')}</td>
  <td class="n">${(100 - m.rate).toFixed(4)}</td>
  <td class="n"><b>${m.rate.toFixed(3)}%</b></td>
  <td class="n ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}">${delta === null ? '—' : (delta > 0 ? '+' : '') + delta.toFixed(1) + 'bp'}</td>
  <td class="n">${m.oi.toLocaleString()}</td></tr>`;
}).join('')}
</tbody>
</table>
</div>
<div class="note">仅列前 16 个合约（近月至约 16 个月）。「较上月」为隐含利率相对前一合约的变动，反映市场对该时段政策变动的定价。</div>

<h2>四、流动性与金融条件</h2>
<div class="grid g3">
  <div class="card"><div class="k">准备金余额</div>
    <div class="v">${liquidity.reserves ? (liquidity.reserves / 1000).toFixed(2) + 'T' : '—'}</div>
    <div class="d">十亿美元 · FRED WRESBAL</div></div>
  <div class="card"><div class="k">ON RRP</div>
    <div class="v">${liquidity.rrp !== null ? liquidity.rrp.toFixed(1) + 'B' : '—'}</div>
    <div class="d">隔夜逆回购余额</div></div>
  <div class="card"><div class="k">TGA 财政部账户</div>
    <div class="v">${liquidity.tga ? (liquidity.tga / 1000).toFixed(2) + 'T' : '—'}</div>
    <div class="d">十亿美元 · FRED WTREGEN</div></div>
  <div class="card"><div class="k">10Y 名义 / 实际</div>
    <div class="v">${F.dgs10} / ${F.real10y}</div>
    <div class="d">期限溢价代理</div></div>
  <div class="card"><div class="k">IG / HY 信用利差</div>
    <div class="v">${F.igSpread} / ${F.hySpread}</div>
    <div class="d">OAS，走阔示风险偏好下降</div></div>
  <div class="card"><div class="k">VIX</div>
    <div class="v">${F.vix}</div>
    <div class="d">金融条件指数 NFCI ${F.nfci}</div></div>
</div>

<h2>五、决议对照表</h2>
<div class="panel">
<table>
<thead><tr><th>维度</th>${meetings.decisions.map(d => `<th class="n">${d.date.slice(5)}</th>`).join('')}<th class="n">变化方向</th></tr></thead>
<tbody>
<tr><td>目标区间上限</td>${meetings.decisions.map(d => `<td class="n">${d.targetUpper}%</td>`).join('')}<td class="n up">↑ 加息</td></tr>
<tr><td>目标区间下限</td>${meetings.decisions.map(d => `<td class="n">${d.targetLower}%</td>`).join('')}<td class="n up">↑</td></tr>
<tr><td>票型</td>${meetings.decisions.map(d => `<td class="n">${d.vote}</td>`).join('')}<td class="n up">转一致</td></tr>
<tr><td>当年末点阵中值</td>${meetings.decisions.map(d => `<td class="n">${d.dotMedian2026}%</td>`).join('')}<td class="n up">↑ 35bp</td></tr>
<tr><td>年内主张加息人数</td>${meetings.decisions.map(d => `<td class="n">${d.dotsFavoringHikesThisYear}</td>`).join('')}<td class="n up">6 → 16</td></tr>
</tbody>
</table>
</div>

<footer>
  <b>数据口径</b>：CME Group 30-Day Federal Funds Futures 官方结算价（productId 305）·
  FRED（fredgraph.csv，无 key）· 美联储 SEP 官方 PDF<br>
  <b>可复算</b>：核心图与路径表均可由原始结算价复算；CME FedWatch 概率无公开 API，仅作交叉校验，不计入本页数值<br>
  <b>更新</b>：${new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16)} SGT ·
  期货曲线 CME 仅保留约 7 个交易日，每日采集留档<br>
  <b>免责</b>：本页为数据分析产物，不构成投资建议。
</footer>

</body>
</html>
`;
}

build();
