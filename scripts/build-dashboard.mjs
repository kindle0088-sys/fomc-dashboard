/**
 * FOMC 看板 · 核心图构建器
 *
 * 产出 docs/index.html：市场隐含路径 vs 美联储 SEP vs 历史路径
 * 涨红跌绿（利率上行标红，符合中国习惯）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  const scenarios = readJson(path.join(DATA, 'derived', 'scenarios.json'));

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

  const html = render({ market, sep, derived, cme, latest, nextMeeting, today, meetings, scenarios });

  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(path.join(DOCS, 'index.html'), html, 'utf8');
  console.log(`✓ docs/index.html 已生成（市场 ${market.length} 点 / SEP ${sep.length} 点${scenarios ? ` / 情景样本 ${scenarios.totalHikes} 次` : ' / ⚠ 无情景数据'}）`);
}

function render({ market, sep, derived, cme, latest, nextMeeting, today, meetings, scenarios }) {
  const P = derived.policy, I = derived.inflation, L = derived.labor, F = derived.financial;
  const liquidity = derived.liquidity;

  // C 轴情景路径（目标区间上限口径）
  const scenPaths = (scenarios && scenarios.axisC && scenarios.axisC.path) || null;
  const scenPts = scenPaths ? Object.values(scenPaths).flat() : [];
  const scenColor = { C1: '#639922', C2: '#EF9F27', C3: '#E24B4A' };
  // 起点统一接当前目标区间上限 4.00%，使三条情景路径与市场路径可同框对照
  const scenEntries = scenPaths
    ? Object.entries(scenPaths).map(([id, pts]) => ({ id, all: [{ k: '2026-09', r: 4.00 }, ...pts.map(p => ({ k: p.date, r: p.rate }))] }))
    : [];

  const maxRate = Math.max(...market.map(m => m.rate), ...sep.map(s => s.rate), ...scenPts.map(p => p.rate));
  const minRate = Math.min(...market.map(m => m.rate), ...sep.map(s => s.rate), ...scenPts.map(p => p.rate));
  const pad = 0.25;
  const yMax = maxRate + pad, yMin = minRate - pad;

  // SVG 尺寸
  const W = 900, H = 400, ML = 62, MR = 30, MT = 30, MB = 52;
  const plotW = W - ML - MR, plotH = H - MT - MB;

  const xs = [...market.map(m => m.key), ...sep.map(s => s.date), ...scenPts.map(p => p.date)].sort();
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
  // ⚠ 逆映射必须用 y = floor((n-1)/12)、m = n - y*12：
  //   toMonthNum = y*12+m，故 2026-12 → 24324，若用 floor(n/12) 会误判为 2027-12（整年偏移）
  const xTicks = [];
  for (let n = Math.ceil(x0 / 3) * 3; n <= x1; n += 3) {
    const y = Math.floor((n - 1) / 12), m = n - y * 12;
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
/* 锚点导航 */
nav.toc{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0 2px}
nav.toc a{font-size:12px;color:var(--tx2);text-decoration:none;padding:4px 11px;border:1px solid var(--line);border-radius:20px;transition:.15s}
nav.toc a:hover{color:var(--tx);border-color:var(--amber)}
/* 三轴 tab */
.tabs>input{display:none}
.tabs>label{display:inline-block;padding:6px 14px;font-size:12.5px;color:var(--tx2);cursor:pointer;
  border:1px solid var(--line);border-bottom:none;border-radius:8px 8px 0 0;margin-right:4px;transition:.15s;position:relative;top:1px}
.tabs>label:hover{color:var(--tx)}
#axA:checked+label[for=axA],#axB:checked+label[for=axB],#axC:checked+label[for=axC]{
  color:var(--tx);background:var(--panel);border-color:var(--amber);border-bottom-color:var(--panel);font-weight:500}
.tabs>.panes{background:var(--panel);border:1px solid var(--line);border-radius:0 10px 10px 10px;padding:14px}
.pane{display:none}
#axA:checked~.panes .paneA,#axB:checked~.panes .paneB,#axC:checked~.panes .paneC{display:block}
/* 情景卡 */
.scg{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(248px,1fr));margin-bottom:16px}
.sc{background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:12px 14px}
.sc .hd{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.sc .id{font-size:10.5px;color:var(--tx3);border:1px solid var(--line);border-radius:4px;padding:1px 5px;font-variant-numeric:tabular-nums}
.sc .nm{font-size:14px;font-weight:500}
.sc .pb{margin-left:auto;font-size:14px;font-variant-numeric:tabular-nums;color:var(--amber)}
.sc .bar{height:4px;border-radius:2px;background:#2A2724;margin:9px 0 0;overflow:hidden}
.sc .bar>i{display:block;height:100%;background:linear-gradient(90deg,#854F0B,var(--amber));border-radius:2px}
.sc .def{font-size:12px;color:var(--tx2);margin-top:9px;line-height:1.65}
.sc .tr{margin-top:9px;font-size:11.5px;color:var(--tx2);line-height:1.85}
.sc .tr b{color:var(--tx3);font-weight:400}
.sc .vd{font-size:11.5px;color:var(--tx2);margin-top:9px;padding-top:8px;border-top:1px dashed var(--line);line-height:1.7}
.sc .an{font-size:11.5px;color:var(--tx2);margin-top:9px;padding-top:8px;border-top:1px dashed var(--line);line-height:1.7}
/* 矩阵表 */
table.mx{font-size:12.5px}
table.mx th.n,table.mx td.n{text-align:right;padding:7px 9px;white-space:nowrap}
table.mx td.ast{font-weight:500;vertical-align:top;padding-top:10px;border-bottom:1px solid var(--line)}
table.mx tbody{border-top:1px solid var(--line)}
table.mx tbody:first-child{border-top:none}
table.mx tr.gA td{background:rgba(55,138,221,.055)}
table.mx tr.gB td{background:rgba(127,119,221,.055)}
table.mx tr.gC td{background:rgba(239,159,39,.055)}
table.mx tr.gD td{background:rgba(226,75,74,.055)}
table.mx .sname{font-size:11px;color:var(--tx3);padding-right:4px}
table.mx .yr{font-size:10px;color:var(--tx3);font-weight:400;margin-top:2px;white-space:nowrap}
table.mx td.big{font-weight:500;font-variant-numeric:tabular-nums}
table.mx td.miss{color:var(--tx3)}
/* 当前实测对照 */
.cur{background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:12px 14px;margin-bottom:16px}
.cur .hd{font-size:12.5px;color:var(--tx2);margin-bottom:10px}
.cur .hd b{color:var(--tx);font-weight:500}
.cur .row{display:flex;flex-wrap:wrap;gap:10px}
.cur .cell{flex:1 1 128px;background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:8px 10px}
.cur .cell .k{font-size:10.5px;color:var(--tx3)}
.cur .cell .v{font-size:16px;font-weight:500;margin-top:3px;font-variant-numeric:tabular-nums}
.cur .cell .c{font-size:10.5px;color:var(--tx3);margin-top:2px}
details{margin-top:12px}
details>summary{cursor:pointer;font-size:12.5px;color:var(--tx2);padding:6px 0;user-select:none;list-style:none}
details>summary::-webkit-details-marker{display:none}
details>summary::before{content:'▸ ';color:var(--tx3)}
details[open]>summary::before{content:'▾ '}
details>summary:hover{color:var(--tx)}
.warnbox{font-size:11.5px;color:var(--tx2);background:rgba(239,159,39,.08);border:1px solid #854F0B;
  border-radius:7px;padding:9px 12px;line-height:1.75;margin-bottom:12px}
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
<nav class="toc">
  <a href="#s1">一 · 政策位置</a>
  <a href="#s2">二 · 核心图</a>
  <a href="#s3">三 · 情景层</a>
  <a href="#s4">四 · 路径明细</a>
  <a href="#s5">五 · 流动性</a>
  <a href="#s6">六 · 决议对照</a>
</nav>

<h2 id="s1">一、政策位置</h2>
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

<h2 id="s2">二、核心图：市场路径 vs 美联储路径</h2>
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

  ${scenEntries.map(e => `<path d="${pathOf(e.all)}" fill="none" stroke="${scenColor[e.id]}" stroke-width="2" stroke-dasharray="2 3" opacity="0.9"/>`
    + e.all.slice(1).map(p => `<circle cx="${px(p.k).toFixed(1)}" cy="${py(p.r).toFixed(1)}" r="3.2" fill="${scenColor[e.id]}"/>`).join('')).join('\n  ')}

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
  <text x="${ML + 10}" y="${MT + 14}" font-size="11" fill="#6F6A63">利率水平（%）</text>
  ${scenEntries.map(e => {
    const last = e.all[e.all.length - 1];
    return `<text x="${(px(last.k) + 8).toFixed(1)}" y="${(py(last.r) + 3.5).toFixed(1)}" font-size="10.5" fill="${scenColor[e.id]}">${e.id} ${last.r.toFixed(2)}%</text>`;
  }).join('')}
</svg>
</div>
<div class="legend">
  <span><i style="border-color:#378ADD"></i>市场隐含路径（CME 期货反算，${market.length} 个合约）</span>
  <span><i style="border-color:#7F77DD;border-top-style:dashed"></i>美联储 SEP 中值（人工补录）</span>
  ${scenPaths ? `<span><i style="border-color:#639922;border-top-style:dotted"></i>C1 温和（终点 4.75%）</span>
  <span><i style="border-color:#EF9F27;border-top-style:dotted"></i>C2 中性（终点 5.25%）</span>
  <span><i style="border-color:#E24B4A;border-top-style:dotted"></i>C3 激进（终点 6.25%）</span>` : ''}
  <span><i style="border-color:#E24B4A"></i>隐含峰值</span>
</div>
<div class="note">
  横轴为合约到期月（YY-MM），纵轴为利率水平（%）。市场路径仅保留有持仓（OI&gt;0）的合约，远月无成交者价格不可信已剔除。
  反算公式：<code>隐含利率 = 100 − settle</code>。利率上行以红色标示（涨红跌绿）。
  <b>口径提示</b>：市场隐含路径与会话 SEP 为<b>有效联邦基金利率</b>口径，C1–C3 情景路径为<b>目标区间上限</b>口径，两者存在约 12bp 的系统性差异（当前上限 4.00% vs EFFR 3.88%），对照时留意。
</div>

${renderScenarioLayer(scenarios)}

<h2 id="s4">四、市场路径明细</h2>
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

<h2 id="s5">五、流动性与金融条件</h2>
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

<h2 id="s6">六、决议对照表</h2>
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
  FRED（fredgraph.csv，无 key）· 美联储 SEP 官方 PDF ·
  长历史资产序列来自 Yahoo v8 chart API（<code>period1=0&amp;interval=1d</code>）<br>
  <b>可复算</b>：核心图、路径表与 L4 情景矩阵均可由原始数据复算
  （<code>collect-history.mjs</code> → <code>build-scenarios.mjs</code>）；
  加息事件日由 FRED DFEDTAR / DFEDTARU 自动探测，非人工录入；CME FedWatch 概率无公开 API，仅作交叉校验，不计入本页数值<br>
  <b>主观部分</b>：三轴情景的概率与触发条件为人工判断（见 <code>config/scenarios.json</code>），需定期复核<br>
  <b>更新</b>：${new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16)} SGT ·
  期货曲线 CME 仅保留约 7 个交易日，每日采集留档<br>
  <b>免责</b>：本页为数据分析产物，不构成投资建议。
</footer>

</body>
</html>
`;
}

// ═══════════════ L4 情景层渲染 ═══════════════

function renderScenarioLayer(sc) {
  if (!sc) {
    return `<h2 id="s3">三、L4 情景层</h2>
<div class="note">⚠ 情景数据尚未生成。请先运行 <code>node scripts/collect-history.mjs</code> 与 <code>node scripts/build-scenarios.mjs</code>。</div>`;
  }

  const WL = { '1d': '1 日', '10d': '10 日', '1m': '1 月', '3m': '3 月', '6m': '6 月', '1y': '1 年' };
  const WK = sc.windowKeys;
  const A = sc.assets || [];

  const cls = v => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
  const num = (v, unit) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const s = unit === 'bp' ? Math.abs(v).toFixed(0) : Math.abs(v).toFixed(2);
    return (v > 0 ? '+' : v < 0 ? '-' : '') + s;
  };

  // 只在 A 轴有数据的资产才入表（避免整行空白）
  const shown = A.filter(a => (sc.axisA.groups || []).some(g => g.matrix && g.matrix[a.key]));

  /** 情景卡片组 */
  const cards = axis => `<div class="scg">${(axis.groups || []).map(g => `
    <div class="sc">
      <div class="hd">
        <span class="id">${g.id}</span><span class="nm">${g.name}</span>
        <span class="pb">${(g.probability * 100).toFixed(0)}%</span>
      </div>
      <div class="bar"><i style="width:${(g.probability * 100).toFixed(0)}%"></i></div>
      ${g.definition ? `<div class="def">${g.definition}</div>` : ''}
      ${g.analogy ? `<div class="an">${g.analogy}</div>` : ''}
      ${g.cycles ? `<div class="tr"><b>历史类比</b>：${g.cycles.join(' · ')}</div>` : ''}
      ${g.triggers ? `<div class="tr"><b>触发条件</b><br>${g.triggers.map(t => '· ' + t).join('<br>')}</div>` : ''}
      ${g.trigger ? `<div class="tr"><b>触发条件</b>：${g.trigger}</div>` : ''}
      ${g.verdict ? `<div class="vd">${g.verdict}</div>` : ''}
      ${g.matrixExcluded
        ? `<div class="an" style="color:var(--amber)">未列入反应矩阵 — 见下方说明</div>`
        : `<div class="an">历史样本 <b>${g.n}</b> 次</div>`}
    </div>`).join('')}</div>`;

  /** 反应矩阵：行=资产(跨组 rowspan)，列=窗口 */
  const matrix = axis => {
    const groups = (axis.groups || []).filter(g => g.matrix && Object.keys(g.matrix).length > 0);
    const excluded = (axis.groups || []).filter(g => g.matrixExcluded);
    if (!groups.length) return '<div class="note">本轴无可用于事件口径的样本。</div>';

    let h = `<table class="mx"><thead><tr><th>资产</th><th>情景 · 样本</th>`
      + WK.map(k => `<th class="n">${WL[k]}</th>`).join('') + `</tr></thead>`;
    for (const a of shown) {
      if (!groups.some(g => g.matrix[a.key])) continue;
      h += `<tbody>`;
      groups.forEach((g, gi) => {
        const cells = WK.map(k => {
          const c = g.matrix[a.key] && g.matrix[a.key][k];
          if (!c) return `<td class="n miss" title="该资产在此事件组无足够历史数据">—</td>`;
          return `<td class="n big ${cls(c.med)}" title="样本 n=${c.n} · Q1 ${num(c.q1, a.unit)} · Q3 ${num(c.q3, a.unit)}">${num(c.med, a.unit)}</td>`;
        }).join('');
        h += `<tr class="g${g.id[0]}">`
          + (gi === 0 ? `<td class="ast" rowspan="${groups.length}">${a.label}`
            + (a.from > '1995-01-01' ? `<div class="yr">${a.from.slice(0, 4)} 起</div>` : '')
            + `</td>` : '')
          + `<td class="sname">${g.id} · n=${g.n}</td>${cells}</tr>`;
      });
      h += `</tbody>`;
    }
    h += `</table>`;
    if (excluded.length) {
      h += excluded.map(g => `<div class="warnbox" style="margin-top:12px"><b>${g.id} ${g.name} 未入表</b>：${g.matrixExcludeReason || '无同口径历史样本。'}</div>`).join('');
    }
    return h;
  };

  /** 当前事件实测 vs A 轴各情景（1 日窗口符号一致度） */
  let curBox = '';
  const cr = sc.currentReaction;
  if (cr) {
    const hits = (sc.axisA.groups || []).map(g => {
      let hit = 0, tot = 0;
      for (const a of shown) {
        const c = cr.matrix && cr.matrix[a.key] && cr.matrix[a.key]['1d'];
        const m = g.matrix && g.matrix[a.key] && g.matrix[a.key]['1d'] && g.matrix[a.key]['1d'].med;
        if (c === undefined || m === undefined || c === 0) continue;
        tot++;
        if (Math.sign(c) === Math.sign(m)) hit++;
      }
      return { id: g.id, name: g.name, hit, tot };
    }).sort((x, y) => (y.tot ? y.hit / y.tot : 0) - (x.tot ? x.hit / x.tot : 0));
    const top = hits[0];

    const cells = ['sp500', 'vix', 'dxy', 'gold', 'dgs10', 'dgs2'].map(k => {
      const a = A.find(x => x.key === k);
      const v = cr.matrix && cr.matrix[k] && cr.matrix[k]['1d'];
      if (!a || v === undefined) return '';
      return `<div class="cell"><div class="k">${a.label}</div>
        <div class="v ${cls(v)}">${num(v, a.unit)}</div>
        <div class="c">${a.unit} · 事件后 1 日</div></div>`;
    }).join('');

    curBox = `<div class="cur">
      <div class="hd">当前事件实测 · <b>${cr.date} +${cr.bp}bp</b>（决议 2026-09-16）　
        与三组历史分布的 1 日反应方向一致度：
        ${hits.map(x => `<b>${x.id} ${x.tot ? x.hit + '/' + x.tot : '—'}</b>`).join('　')}
        ${top && top.tot ? `　→ 最接近 <b>${top.id} ${top.name}</b>` : ''}
      </div>
      <div class="row">${cells}</div>
    </div>`;
  }

  const methodology = `
<details>
  <summary>方法论与口径（点击展开）</summary>
  <div class="note">
    <b>事件日 t0</b>：目标利率生效日，由 FRED <code>DFEDTAR</code>（1982–2008）+ <code>DFEDTARU</code>（2008–今）自动探测，非人工录入。<br>
    <b>基准</b>：t0 前一交易日收盘——保证基准尚未反映新政。反应 = 第 n 个交易日后的值与基准之差。<br>
    <b>窗口</b>：按交易日计 ${WK.map(k => `${WL[k]}=${sc.method.windows.find(w => w.key === k).n}`).join(' / ')} 日。<br>
    <b>统计量</b>：组内<b>中位数</b>（比均值稳健，避免单个极端事件主导）；鼠标悬停单元格可见 Q1/Q3 与有效样本数。<br>
    <b>单位</b>：价格类资产为 % 变化；国债收益率为 bp 变化；VIX 为绝对点数变化。<br>
    <b>样本池</b>：1994 年至今共 <b>${sc.totalHikes}</b> 次加息（${sc.method.exclusion}）。<br>
    <b>主观 vs 客观</b>：概率与触发条件为人工判断，<b>需定期复核</b>；反应矩阵为自动计算的客观结果。
  </div>
</details>`;

  return `
<h2 id="s3">三、L4 情景层（三轴）</h2>
<div class="note" style="margin-top:-4px;margin-bottom:14px">
  三轴共用同一套历史事件样本与同一计算口径，区别只在<b>事件如何分组</b>——它们回答的是三个不同层面的问题，因此可以同时成立。
</div>

<div class="tabs">
  <input type="radio" name="ax" id="axA" checked>
  <label for="axA">A · 本轮加息的性质</label>
  <input type="radio" name="ax" id="axB">
  <label for="axB">B · 单场会议结果</label>
  <input type="radio" name="ax" id="axC">
  <label for="axC">C · 本轮加息终点</label>

  <div class="panes">
    <section class="pane paneA">
      <div class="note" style="margin:0 0 12px">${sc.axisA.label} —— ${sc.axisA.question}　<span style="color:var(--tx2)">${sc.axisA.hint || ''}</span></div>
      ${curBox}
      ${cards(sc.axisA)}
      <div class="panel" style="background:transparent;border:none;padding:0">${matrix(sc.axisA)}</div>
      <div class="note">按<b>周期性质</b>分组。样本 = 该性质全部周期内的加息事件。回答：「如果是这种性质的周期，每次加息后市场怎么动？」</div>
    </section>

    <section class="pane paneB">
      <div class="note" style="margin:0 0 12px">${sc.axisB.label} —— ${sc.axisB.question}　<span style="color:var(--tx2)">${sc.axisB.hint || ''}</span></div>
      ${sc.axisB.note ? `<div class="warnbox">${sc.axisB.note}</div>` : ''}
      ${cards(sc.axisB)}
      <div class="panel" style="background:transparent;border:none;padding:0">${matrix(sc.axisB)}</div>
      <div class="note">按<b>单次幅度</b>分组。回答：「这一夜如果这样走，市场历史上给出什么反应？」</div>
    </section>

    <section class="pane paneC">
      <div class="note" style="margin:0 0 12px">${sc.axisC.label} —— ${sc.axisC.question}　<span style="color:var(--tx2)">${sc.axisC.hint || ''}</span></div>
      ${sc.axisC.note ? `<div class="warnbox">${sc.axisC.note}</div>` : ''}
      ${cards(sc.axisC)}
      <div class="panel" style="background:transparent;border:none;padding:0">${matrix(sc.axisC)}</div>
      <div class="note">按<b>所属周期的累计加息幅度</b>分组。回答：「如果是这种终点的周期，中途每次加息的市场反应如何？」</div>
    </section>
  </div>
</div>

${methodology}`;
}

export { build };

// 仅在被直接执行时自运行；被 import 时由调用方调用 build()
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  build();
}
