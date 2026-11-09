#!/usr/bin/env node
/**
 * polymarket-agent 运维 CLI
 * 用法：node scripts/cli.mjs <命令>
 *   status                      运行快照
 *   run                         立即触发一轮主循环
 *   light                       立即触发一次轻触发（持仓监控）
 *   score                       评分仪表盘（brier_delta/校准/阈值扫描/规则）
 *   verify                      账本完整性校验
 *   ledger [n]                  最近 n 条账本记录（默认 10）
 *   kill on [理由] / kill off   置位/解除 kill switch
 *   watch [秒]                  持续轮询 status（默认 30s）
 * 环境变量：AGENT_URL（默认 http://localhost:3000）
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.AGENT_URL ?? 'http://localhost:3000';
const CYCLES_LOG = resolve(process.cwd(), 'data/cycles.log');

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

async function api(path, init) {
  let resp;
  try {
    resp = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(600_000), ...init });
  } catch {
    console.error(C.red(`✗ 无法连接 ${BASE} —— agent 是否已启动？（npm start）`));
    process.exit(1);
  }
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return text; }
}

const fmt = (n, d = 2) => (n == null ? '—' : Number(n).toFixed(d));
const pct = (n) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`);

function printStatus(s) {
  console.log(C.bold(`\n polymarket-agent @ ${BASE}`));
  console.log(` 模式: ${C.cyan(s.mode.llm)}/${C.cyan(s.mode.broker)}${s.mode.twinOrders ? C.yellow(' +孪生单') : ''}  kill switch: ${s.killSwitch ? C.red('已置位') : C.green('正常')}`);
  const w = s.wallet;
  console.log(` 资金: 现金 ${C.green(`$${fmt(w.cashUsd)}`)} · 敞口 $${fmt(w.totalExposure)} · 持仓 ${w.openPositions} · 峰值 $${fmt(w.peakEquity)} · 回撤 ${w.drawdown > 0.1 ? C.red(pct(w.drawdown)) : pct(w.drawdown)} · 日盈亏 ${w.dailyPnl >= 0 ? C.green(`+$${fmt(w.dailyPnl)}`) : C.red(`-$${fmt(Math.abs(w.dailyPnl))}`)}`);
  const f = s.forecasts;
  console.log(` 预测: 总 ${f.total} · 进行中 ${f.open} · 已结算 ${f.settled} · 下注 ${f.bets}`);
  const sc = s.score;
  const delta = sc.brierDelta;
  console.log(` 评分: brier_delta ${delta < 0 ? C.green(fmt(delta, 4)) : delta > 0 ? C.red(fmt(delta, 4)) : '0.0000'}（n=${sc.settled}，占优 ${(sc.brierDeltaWins * 100).toFixed(0)}%）· 幸运z ${sc.luckZ == null ? '—' : fmt(sc.luckZ)} · ROI ${sc.bets.roi == null ? '—' : pct(sc.bets.roi)}`);
  const lv = s.ledgerVerify;
  console.log(` 账本: ${lv.ok ? C.green('✓ 完整') : C.red(`✗ 第 ${lv.brokenAtId} 条被篡改`)}（${lv.total} 条）`);
  if (s.lastCycle) {
    console.log(` 上一轮: #${s.lastCycle.id} ${s.lastCycle.finishedAt ? C.dim(`已结束 ${s.lastCycle.finishedAt}`) : C.yellow('运行中…')}`);
  }
  if (s.openPositions?.length) {
    console.log(C.bold('\n 持仓:'));
    for (const p of s.openPositions) {
      console.log(`  #${p.id} ${C.dim(fmt(p.shares) + '份@' + fmt(p.avgPrice, 3))} $${fmt(p.costUsd)} · ${(p.question ?? '').slice(0, 46)}`);
    }
  }
  console.log('');
}

function printScore(d) {
  const s = d.summary;
  console.log(C.bold('\n 评分仪表盘'));
  console.log(` 已结算 ${s.settled} · agent brier ${fmt(s.meanBrierAgent, 4)} vs 市场 ${fmt(s.meanBrierMarket, 4)} → delta ${s.brierDelta < 0 ? C.green(fmt(s.brierDelta, 4)) : C.red(fmt(s.brierDelta, 4))}`);
  console.log(` 下注 n=${s.bets.n} · 已实现 $${fmt(s.bets.realizedPnl)} · ROI ${s.bets.roi == null ? '—' : pct(s.bets.roi)}`);
  console.log(C.bold('\n 校准表（10 桶，bias = 实际频率 − 预测均值）:'));
  for (const b of s.calibration) {
    if (!b.n) continue;
    const bar = '█'.repeat(Math.min(20, Math.round(b.n / Math.max(1, s.settled) * 20)));
    console.log(`  ${b.lo.toFixed(1)}-${b.hi.toFixed(1)}  n=${String(b.n).padStart(4)}  ${C.cyan(bar)}  bias ${Math.abs(b.bias) < 0.05 ? C.green(fmt(b.bias, 3)) : C.red(fmt(b.bias, 3))}`);
  }
  console.log(C.bold('\n 阈值扫描（反事实平注 ROI）:'));
  for (const t of d.thresholdSweep ?? []) {
    console.log(`  min_edge ${(t.minEdge * 100).toFixed(0)}%  n=${String(t.n).padStart(4)}  ROI ${t.flatBetRoi == null ? '—' : t.flatBetRoi >= 0 ? C.green(pct(t.flatBetRoi)) : C.red(pct(t.flatBetRoi))}`);
  }
  const rules = d.rules ?? [];
  if (rules.length) {
    console.log(C.bold('\n 规则:'));
    for (const r of rules) {
      console.log(`  [${r.status}] ${r.name} · n=${r.n} · t=${r.tStat == null ? '—' : fmt(r.tStat, 3)}`);
    }
  }
  console.log('');
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'status': case undefined: {
      printStatus(await api('/status'));
      break;
    }
    case 'run': {
      console.log(C.dim('触发主循环（可能需要几分钟，research 模式约 10 分钟）…'));
      const r = await api('/cycle/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"trigger":"manual"}' });
      if (r.ok) {
        const s = r.summary;
        console.log(C.green(`✓ 周期 #${s.cycleId} 完成`));
        console.log(`  扫描 ${s.scanned} → 硬过滤 ${s.hardPassed} → 入选 ${s.selected} → 预测 ${s.forecasted} · 下注 ${s.bets} · 拒绝 ${s.rejected} · 错误 ${s.errors}`);
      } else console.error(C.red(`✗ ${JSON.stringify(r)}`));
      break;
    }
    case 'light': {
      const r = await api('/cycle/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"trigger":"light"}' });
      console.log(r.ok ? C.green(`✓ 轻触发完成：检查 ${r.summary.checked} 个持仓，平仓 ${r.summary.closed}`) : C.red(JSON.stringify(r)));
      break;
    }
    case 'score': printScore(await api('/ops/score')); break;
    case 'verify': {
      const v = await api('/ops/ledger/verify');
      console.log(v.ok ? C.green(`✓ 账本完整（${v.total} 条）`) : C.red(`✗ 第 ${v.brokenAtId} 条被篡改！`));
      break;
    }
    case 'kill': {
      const on = args[0] === 'on';
      const reason = args.slice(1).join(' ') || 'cli';
      const r = await api('/ops/kill-switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: on, reason }) });
      console.log(r.ok ? (r.engaged ? C.red('⛔ kill switch 已置位 —— 主循环将全部跳过') : C.green('✓ kill switch 已解除')) : C.red(JSON.stringify(r)));
      break;
    }
    case 'watch': {
      const interval = Number(args[0] ?? 30) * 1000;
      for (;;) {
        console.clear();
        printStatus(await api('/status'));
        console.log(C.dim(`（每 ${interval / 1000}s 刷新，Ctrl+C 退出）`));
        await new Promise((r) => setTimeout(r, interval));
      }
    }
    case 'logs': {
      const n = Number(args[0] ?? 60);
      if (!existsSync(CYCLES_LOG)) {
        console.log(C.yellow(`暂无周期日志（${CYCLES_LOG}）—— 启动 agent 并跑完一轮后生成`));
        break;
      }
      const lines = readFileSync(CYCLES_LOG, 'utf8').trimEnd().split('\n');
      console.log(C.dim(`data/cycles.log 最近 ${Math.min(n, lines.length)} 行（共 ${lines.length} 行）\n`));
      console.log(lines.slice(-n).join('\n'));
      break;
    }
    default:
      console.log(`polymarket-agent 运维 CLI

用法: node scripts/cli.mjs <命令>
  ${C.cyan('status')}            运行快照（默认命令）
  ${C.cyan('run')}               立即触发一轮主循环
  ${C.cyan('light')}             触发轻触发（持仓监控/止盈止损）
  ${C.cyan('score')}             评分仪表盘（brier_delta/校准/阈值扫描）
  ${C.cyan('verify')}            账本完整性校验
  ${C.cyan('kill on [理由]')}    置位 kill switch（紧急停止）
  ${C.cyan('kill off')}          解除 kill switch
  ${C.cyan('watch [秒]')}        持续刷新状态（默认 30s）
  ${C.cyan('logs [行数]')}       查看周期详细日志尾部（默认 60 行，来自 data/cycles.log）

提示: npm run cli -- status  等价  node scripts/cli.mjs status
环境: AGENT_URL 可指定远端地址（默认 http://localhost:3000）`);
  }
}

main();
