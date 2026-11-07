#!/usr/bin/env node
/**
 * archive-cycle.mjs — 把某一期决议的「冻结状态」固化成 archive/<meeting>/frozen.json
 *
 * 为什么不直接读当前 config：config 会随新周期被改掉，derived 每次日更都会覆盖。
 * 期初的预测只活在 git 对象里，一次 rebase 就没了 —— 所以必须显式落盘。
 *
 * 用法（git 抽取在 shell 侧做，脚本本身不调 git）：
 *   git show <commit>:config/scenarios.json        > .tmp/frozen-config.json
 *   git show <commit>:data/derived/market-implied.json > .tmp/frozen-market.json
 *   node scripts/archive-cycle.mjs --config .tmp/frozen-config.json \
 *        --market .tmp/frozen-market.json --meeting 2026-10-28 --commit f514d3c
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const cfgPath = arg('config');
const mktPath = arg('market');
const meeting = arg('meeting');
const commit = arg('commit', 'unknown');

if (!cfgPath || !mktPath || !meeting) {
  console.error('用法: node scripts/archive-cycle.mjs --config <f> --market <f> --meeting YYYY-MM-DD [--commit sha]');
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const mkt = JSON.parse(fs.readFileSync(mktPath, 'utf8'));

const AXES = ['axisA', 'axisB', 'axisC'];

const axes = {};
const frozenDisplay = {};
for (const k of AXES) {
  const a = cfg[k];
  if (!a) continue;
  const key = k.replace('axis', '');
  axes[key] = {
    label: a.label || null,
    question: a.question || null,
    hint: a.hint || null,
    nextMeeting: a.nextMeeting || null,
    groups: (a.groups || []).map((g) => ({
      id: g.id,
      name: g.name || g.label || null,
      probability: g.probability,
      analogy: g.analogy || null,
      range: g.range || null,
      matrixExcluded: !!g.matrixExcluded,
    })),
  };
  frozenDisplay[key] = Object.fromEntries((a.groups || []).map((g) => [g.id, g.probability]));
}

const out = {
  schema: 1,
  cycle: meeting,
  meeting,
  frozenAt: new Date().toISOString(),
  frozenCommit: commit,
  sourceNote: `从 git 提交 ${commit} 抽取；该提交为该期决议前的最后一次冻结`,
  current: cfg.current || null,
  marketImplied: {
    cmeTradeDate: mkt.source?.cmeTradeDate || null,
    effr: mkt.source?.effr ?? null,
    maxResidBp: mkt.fitQuality?.maxResidBp ?? null,
    nextMeeting: mkt.nextMeeting || null,
    terminal: mkt.terminal || null,
  },
  axes,
  frozenDisplay,
};

const dir = path.join(ROOT, 'archive', meeting);
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'frozen.json');
fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf8');

console.log('✅ 已归档: ' + path.relative(ROOT, file));
console.log('   会议日      : ' + meeting);
console.log('   冻结提交    : ' + commit);
console.log('   数据时点    : CME ' + out.marketImplied.cmeTradeDate + ' ｜ 残差 ' + out.marketImplied.maxResidBp + 'bp');
for (const k of Object.keys(frozenDisplay)) {
  const s = Object.entries(frozenDisplay[k]).map(([id, p]) => id + ' ' + (p * 100).toFixed(0) + '%').join(' / ');
  console.log('   轴 ' + k + '        : ' + s);
}
console.log('   下一场指针  : ' + (out.marketImplied.nextMeeting?.decision || '-')
  + ' ｜ 市场 P(+25bp) ' + ((out.marketImplied.nextMeeting?.p25 ?? 0) * 100).toFixed(0) + '%');
