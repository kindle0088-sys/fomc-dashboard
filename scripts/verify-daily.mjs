#!/usr/bin/env node
/**
 * 日更自检 —— 跑在 23:30 定时任务之后，回答一个问题：
 *   「今天的数据到底有没有真的更新到看板上？」
 *
 * 为什么需要它：2026-11-12 之前，build-scenarios 算出偏离只打一行告警，
 * 看板照旧渲染 config 里的旧概率，连续两天没人发现。日志里全是 ✓，
 * 看板上却是两年前的数。所以自检不能看「任务有没有跑完」，
 * 要看「产物里的数字是不是今天算的、来源是不是数据而不是配置」。
 *
 * 用法: node scripts/verify-daily.mjs [--date YYYY-MM-DD]
 * 退出码 0 = 全部正常；1 = 有异常（会列出哪一条）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = (...a) => path.join(ROOT, ...a);

/** SGT = UTC+8；所有日期判断都用这个，别用本机时区 */
const sgt = (d = new Date()) => new Date(d.getTime() + 8 * 3600 * 1000);
const todaySGT = () => sgt().toISOString().slice(0, 10);

const argDate = (() => {
  const i = process.argv.indexOf('--date');
  return i > -1 ? process.argv[i + 1] : null;
})();
const day = argDate || todaySGT();

const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const readJson = f => { try { return JSON.parse(read(f)); } catch { return null; } };
const stat = f => { try { return fs.statSync(f); } catch { return null; } };

const rows = [];
const add = (name, ok, detail = '') => rows.push({ name, ok, detail });

/* ① 日志：今天的 6 步是否都完成，有没有 FATAL / ⚠ */
{
  const logTxt = read(P('logs/daily.log')) || '';
  const todayBlock = logTxt.split(/(?=\[20\d\d-\d\d-\d\dT)/).filter(b => b.startsWith(`[${day}T`));
  const block = todayBlock.join('');
  const done = /=== 完成 ===/.test(block);
  const steps = [...block.matchAll(/✓ (\d)\/6 (\S+)/g)].map(m => m[1]);
  const fatal = /FATAL/.test(block);
  /* ⚠ 有两类：一类是每天都打的口径说明（如「峰值只在流动性区间内取」），
     一类是真异常。只把后者算告警，否则自检本身天天报假警，久了就没人看。 */
  const REAL_WARN = /失败|错误|异常|回退|不一致|超时|限流|403|429|偏离\s*\d+pp|未落盘|空跑/;
  const warn = [...block.matchAll(/⚠[^\n]*/g)].map(m => m[0].trim()).filter(t => REAL_WARN.test(t));
  add('日更日志有今天的完成标记', done, done ? `${todayBlock.length} 行` : `logs/daily.log 里没有 ${day} 的「=== 完成 ===」`);
  add('6 个步骤全部 ✓', steps.length === 6 && !fatal, fatal ? '有 FATAL' : `完成 ${steps.length}/6 步`);
  add('日志无告警', warn.length === 0, warn.join(' ｜ ') || '无');
}

/* ② 数据新鲜度：market-implied / scenarios 必须是今天算的 */
const mi = readJson(P('data/derived/market-implied.json'));
const sc = readJson(P('data/derived/scenarios.json'));
const stMI = stat(P('data/derived/market-implied.json'));
const dayOf = j => (j?.generatedAt || '').slice(0, 10);

add('market-implied 是今天的', dayOf(mi) === day, mi ? dayOf(mi) : '文件缺失');
add('scenarios 是今天的', dayOf(sc) === day, sc ? dayOf(sc) : '文件缺失');

/* ③ 最关键的一条：概率来源必须是数据，不能回退 config */
const srcB = sc?.axisB?.probabilitySource;
const srcC = sc?.axisC?.probabilitySource;
add('B 轴概率来自 market-implied', srcB === 'market-implied',
  srcB === 'market-implied' ? '✓' : `实际 ${srcB || '未标记'}（回退到 config = 看板会显示人工旧值）`);
add('C 轴概率来自 market-implied', srcC === 'market-implied',
  srcC === 'market-implied' ? '✓' : `实际 ${srcC || '未标记'}`);

/* ④ 概率与隐含路径一致（防「标了 market-implied 但值没跟着变」） */
if (mi?.nextMeeting && sc?.axisB?.groups) {
  const b1 = sc.axisB.groups.find(g => g.key === 'hike25');
  const want = Math.round(Math.max(0, Math.min(1, mi.nextMeeting.p25)) * 100);
  const got = b1 ? Math.round(b1.probability * 100) : null;
  add('B1 等于隐含 P(25bp)', got === want, `卡片 ${got}% / 隐含 ${want}%`);
  const sum = sc.axisB.groups.reduce((a, g) => a + g.probability, 0);
  add('B 轴概率归一', Math.abs(sum - 1) < 0.02, `合计 ${sum.toFixed(3)}`);
}
if (sc?.axisC?.groups) {
  const sum = sc.axisC.groups.reduce((a, g) => a + g.probability, 0);
  add('C 轴概率归一', Math.abs(sum - 1) < 0.02, `合计 ${sum.toFixed(3)}`);
}

/* ⑤ 卡片正文的占位符必须已灌值，不能留 {p25} 这种 */
{
  const b1 = sc?.axisB?.groups?.find(g => g.key === 'hike25');
  const left = /\{\w+\}/.test(b1?.analogy || '');
  add('B 轴文案占位符已填充', !left, left ? '仍有 {xxx} 未替换' : '✓');
}

/* ⑥ 看板产物必须晚于数据，且带「市场」来源标记 */
{
  const stHtml = stat(P('docs/index.html'));
  const newer = stHtml && stMI && stHtml.mtimeMs >= stMI.mtimeMs - 1000;
  add('看板已按最新数据重建', !!newer,
    stHtml ? `看板 ${sgt(stHtml.mtime).toISOString().slice(11, 16)} / 数据 ${stMI ? sgt(stMI.mtime).toISOString().slice(11, 16) : '—'} SGT` : '看板缺失');
  const html = read(P('docs/index.html')) || '';
  const n = (html.match(/class="psrc"/g) || []).length;
  add('看板标出概率来源', n >= 7, `${n} 处（B 4 + C 3）`);
  const stale = (html.match(/class="psrc stale"/g) || []).length;
  add('看板无「配置」回退标记', stale === 0, stale ? `${stale} 处回退` : '✓');
}

/* ⑦ git：数据快照是否已提交并推送 */
{
  let head = '', remote = '', dirty = '';
  try {
    head = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
    remote = execSync('git rev-parse --short origin/main', { cwd: ROOT }).toString().trim();
    dirty = execSync('git status --porcelain', { cwd: ROOT }).toString().trim();
  } catch (e) { /* git 不可用时下面会报 */ }
  add('HEAD 与 origin/main 一致', !!head && head === remote, `本地 ${head || '?'} / 远程 ${remote || '?'}`);
  add('工作区干净', dirty === '', dirty ? dirty.split('\n').length + ' 个改动未提交' : '✓');
}

/* ── 输出 ── */
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0)));
console.log(`\n▸ FOMC 日更自检 · 目标日期 ${day}（SGT）\n`);
for (const r of rows) {
  console.log(`  ${r.ok ? '✅' : '❌'} ${pad(r.name, 34)} ${r.detail}`);
}
const bad = rows.filter(r => !r.ok);
console.log(`\n${rows.length - bad.length} 通过 / ${bad.length} 失败\n`);

if (bad.length) {
  console.log('建议顺序：① 看 logs/daily.log 最后一段 ② 单独跑 market-implied.mjs 看是否有数据 ③ 再跑 build-scenarios + build-dashboard');
}
process.exit(bad.length ? 1 : 0);
