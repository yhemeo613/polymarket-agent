import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';

const W = 62;
const line = (ch = '─') => ch.repeat(W);
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** 周期日志落盘：所有控制台输出同步追加到 data/cycles.log（UTF-8，控制台乱码时的可靠查看处） */
export const CYCLES_LOG = path.resolve('data/cycles.log');

export function appendCycleLog(cleanLine: string): void {
  try {
    fs.mkdirSync(path.dirname(CYCLES_LOG), { recursive: true });
    fs.appendFileSync(CYCLES_LOG, `${new Date().toISOString()} ${cleanLine}\n`, 'utf8');
  } catch {
    /* 日志落盘失败不阻塞主流程 */
  }
}

/**
 * 主循环 CLI 过程渲染器：把无人值守的运行过程实时画到控制台 + 落盘 cycles.log。
 * 纯输出，无业务逻辑；pino 结构化日志照常并行。
 */
export class CycleReporter {
  private readonly start = Date.now();

  private static ts(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  /** 供外部模块使用的时间戳（HH:MM:SS） */
  static stamp(): string {
    return CycleReporter.ts();
  }

  private elapsed(): string {
    return chalk.gray(`[+${((Date.now() - this.start) / 1000).toFixed(0)}s]`);
  }

  /** 双写输出：控制台（彩色）+ data/cycles.log（纯文本 UTF-8） */
  private out(colored: string): void {
    console.log(colored);
    appendCycleLog(colored.replace(ANSI_RE, ''));
  }

  banner(cycleId: number, mode: string, trigger: string): void {
    this.out('');
    this.out(chalk.cyan(`╔${line('═')}╗`));
    const title = `  周期 #${cycleId} · ${mode} · 触发:${trigger} · ${CycleReporter.ts()}`;
    this.out(chalk.cyan('║') + chalk.bold.white(title.padEnd(W - 1)) + chalk.cyan('║'));
    this.out(chalk.cyan(`╚${line('═')}╝`));
  }

  phase(n: number, total: number, label: string): void {
    this.out(`\n${chalk.blue(`[${n}/${total}]`)} ${chalk.bold(label)} …`);
  }

  phaseDone(detail: string): void {
    this.out(`      ${chalk.green('✓')} ${chalk.gray(detail)}`);
  }

  phaseWarn(detail: string): void {
    this.out(`      ${chalk.yellow('!')} ${chalk.gray(detail)}`);
  }

  marketHeader(idx: number, total: number, question: string): void {
    const q = question.length > 52 ? question.slice(0, 49) + '…' : question;
    this.out(`  ${chalk.whiteBright(`▸ ${idx}/${total}`)} ${q}`);
  }

  marketStep(text: string): void {
    this.out(`      ${chalk.gray('·')} ${chalk.gray(text)}`);
  }

  marketSkip(reason: string): void {
    const short = reason.length > 60 ? reason.slice(0, 57) + '…' : reason;
    this.out(`      ${chalk.yellow('⊘ SKIP')} ${chalk.dim(short)}`);
  }

  betLine(detail: string): void {
    this.out(`      ${chalk.green('★ BET')}  ${chalk.green(detail)}`);
  }

  rejectedLine(detail: string): void {
    this.out(`      ${chalk.red('✗ 风控拒绝')} ${chalk.dim(detail)}`);
  }

  errorLine(text: string): void {
    this.out(`      ${chalk.red('× 错误')} ${chalk.red(text.slice(0, 80))}`);
  }

  divider(): void {
    this.out(chalk.gray(`  ${line()}`));
  }

  summary(rows: {
    scanned: number; hardPassed: number; selected: number; forecasted: number;
    bets: number; rejected: number; errors: number; skipCount: number;
    settledConditions?: number;
  }, wallet: { cashUsd: number; totalExposure: number; openPositions: number; drawdown: number }): void {
    const dur = ((Date.now() - this.start) / 1000).toFixed(0);
    const dd = (wallet.drawdown * 100).toFixed(1);
    this.out(`\n${chalk.cyan(`  ${line()}`)}`);
    this.out(chalk.bold.white('  周期摘要'));
    this.out(`  扫描 ${chalk.whiteBright(rows.scanned)} → 硬过滤 ${chalk.whiteBright(rows.hardPassed)} → 入选 ${chalk.whiteBright(rows.selected)}`);
    this.out(`  预测 ${chalk.whiteBright(rows.forecasted)} | ${chalk.green(`下注 ${rows.bets}`)} | ${chalk.yellow(`跳过 ${rows.skipCount}`)} | ${chalk.red(`拒绝 ${rows.rejected}`)} | 错误 ${rows.errors}${rows.settledConditions != null ? ` | 结算 ${rows.settledConditions}` : ''}`);
    this.out(`  现金 ${chalk.green(`$${wallet.cashUsd.toFixed(2)}`)} | 敞口 $${wallet.totalExposure.toFixed(2)} | 持仓 ${wallet.openPositions} | 回撤 ${dd}%`);
    this.out(chalk.gray(`  耗时 ${dur}s · ${CycleReporter.ts()}`));
    this.out(chalk.cyan(`  ${line()}`));
  }
}
