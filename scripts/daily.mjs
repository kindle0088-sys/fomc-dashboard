#!/usr/bin/env node
/**
 * 每日采集 + 归档 + 提交
 * 计划任务入口。CME 只保留约 7 天，务必每个工作日跑。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LOG = path.join(ROOT, 'logs');

fs.mkdirSync(LOG, { recursive: true });
const logFile = path.join(LOG, 'daily.log');

function log(line) {
  const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00');
  const msg = `[${stamp}] ${line}\n`;
  fs.appendFileSync(logFile, msg, 'utf8');
  process.stdout.write(msg);
}

/** 找可用的 git（禁止硬编码 node 版本路径；git 用内置 PortableGit） */
function findGit() {
  const candidates = [
    'C:/Users/jiali/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd/git.exe',
    'C:/Program Files/Git/cmd/git.exe',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { cwd: ROOT, encoding: 'utf8', timeout: 180000, ...opts });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function main() {
  log('=== FOMC 看板每日采集 开始 ===');

  // 环境自检
  const nodeExe = process.execPath;
  const git = findGit();
  log(`node: ${nodeExe}`);
  log(`git : ${git || '✗ 未找到'}`);
  if (!git) {
    log('✗ 缺少 git，终止');
    process.exit(1);
  }

  // 1. 采集
  const collect = run(nodeExe, [path.join(HERE, 'collect.mjs')]);
  log('--- collect 输出 ---');
  log(collect.out || '(空)');
  if (collect.err) log('stderr: ' + collect.err);
  if (collect.code !== 0) log(`⚠ collect 退出码 ${collect.code}`);

  // 2. git 提交（失败不致命）
  run(git, ['config', 'gc.auto', '0']);
  const status = run(git, ['status', '--porcelain']);
  if (!status.out) {
    log('无变更，跳过提交');
  } else {
    run(git, ['add', '-A']);
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const c = run(git, ['commit', '-m', `chore: data snapshot ${today}`]);
    log(c.out || c.err);
    const p = run(git, ['push', 'origin', 'HEAD']);
    log(p.code === 0 ? '✓ 已推送' : `⚠ push 失败：${p.err}`);
  }

  log('=== 完成 ===\n');
}

main();
