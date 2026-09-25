#!/usr/bin/env node
/**
 * 每日采集 + 归档 + 提交
 * 计划任务入口。CME 只保留约 7 天，务必每个工作日跑。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LOG = path.join(ROOT, 'logs');
const nodeExe = process.execPath;

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
  const r = spawnSync(bin, args, { cwd: ROOT, encoding: 'utf8', timeout: 300000, ...opts });
  // r.error 非空 = 进程根本没起来（EBUSY/ENOENT/EACCES…），此时 status 为 null。
  // 必须显式暴露，否则会被当成"退出码 null"静默略过，任务看似成功实则什么都没做。
  const spawnError = r.error ? `${r.error.code || 'ERR'}: ${r.error.message}` : null;
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), spawnError };
}

/** 跑一个步骤，带回退：spawn 不可用时改为同进程动态 import */
async function step(label, scriptPath) {
  log(`--- ${label} 开始 ---`);
  const r = run(nodeExe, [scriptPath]);

  if (r.spawnError) {
    // 某些受限环境禁止创建子进程（EBUSY）。回退到同进程 import 并 await 其 main()——
    // 语义等价：每个子脚本都是"跑完即退出"的独立模块，不共享跨步骤状态。
    log(`⚠ ${label} 无法创建子进程（${r.spawnError}），回退为同进程调用`);
    const base = path.basename(scriptPath);
    try {
      const mod = await import(pathToFileURL(scriptPath).href);
      // build-dashboard 导出的是 build()，其余导出 main()
      const fn = typeof mod.main === 'function' ? mod.main : (typeof mod.build === 'function' ? mod.build : null);
      if (!fn) throw new Error(`${base} 未导出 main()/build()，无法回退`);
      const rc = await fn();
      if (typeof rc === 'number' && rc !== 0) throw new Error(`${base} 返回码 ${rc}`);
      log(`✓ ${label} 完成（回退模式）`);
      return true;
    } catch (e) {
      log(`✗ ${label} 回退执行失败：${e.message}`);
      return false;
    }
  }

  if (r.out) log(r.out);
  if (r.err) log('stderr: ' + r.err);
  if (r.code !== 0) {
    log(`✗ ${label} 退出码 ${r.code}`);
    return false;
  }
  log(`✓ ${label} 完成`);
  return true;
}

async function main() {
  log('');
  log('=== FOMC 看板每日采集 开始 ===');

  // 环境自检
  const git = findGit();
  log(`node: ${nodeExe}`);
  log(`git : ${git || '✗ 未找到'}`);
  if (!git) {
    log('✗ 缺少 git，终止');
    process.exit(1);
  }

  // 各步骤失败即终止：宁可任务报红，也不要静默产出空数据
  const steps = [
    ['1/4 collect（现状层：CME + FRED）', path.join(HERE, 'collect.mjs')],
    ['2/4 collect-history（长历史 + 加息事件探测）', path.join(HERE, 'collect-history.mjs')],
    ['3/4 build-scenarios（L4 情景层）', path.join(HERE, 'build-scenarios.mjs')],
    ['4/4 build-dashboard（看板）', path.join(HERE, 'build-dashboard.mjs')],
  ];
  for (const [label, script] of steps) {
    if (!(await step(label, script))) {
      log('✗ 作业中止（数据可能不完整，未提交）');
      process.exit(1);
    }
  }

  // 5. git 提交
  // git 是外部二进制，无法像 node 脚本那样回退为同进程 import。
  // 若 spawn 被环境禁止，必须明确报告"未提交"，绝不能静默当成成功。
  const gc = run(git, ['config', 'gc.auto', '0']);
  if (gc.spawnError) {
    log(`⚠ 无法调用 git（${gc.spawnError}）`);
    log('⚠ 数据已更新但【未提交未推送】——请手动执行 git add/commit/push');
    log('=== 完成（git 步骤跳过）===');
    log('');
    process.exit(0);
  }

  // 先把本地对齐远程，保证 push 是快进（避免非快进被拒）
  run(git, ['fetch', 'origin', 'main']);
  const ff = run(git, ['merge', '--ff-only', 'FETCH_HEAD']);
  if (ff.code !== 0 && !/Already up to date/i.test(ff.out + ff.err)) {
    log(`⚠ 远程对齐失败：${ff.err || ff.out}`);
  }

  const status = run(git, ['status', '--porcelain']);
  if (!status.out) {
    log('无变更，跳过提交');
  } else {
    run(git, ['add', '-A']);
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const c = run(git, ['commit', '-m', `chore: data snapshot ${today}`]);
    log(c.out || c.err);
    const p = run(git, ['push', 'origin', 'HEAD']);
    if (p.code === 0) log('✓ 已推送');
    else log(`⚠ push 失败（数据已本地提交，但未推送）：${p.err || p.out}`);
  }

  log('=== 完成 ===');
  log('');
}

main().catch(e => {
  log('FATAL ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
