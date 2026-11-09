import chalk from 'chalk';

const W = 62;
const line = (ch = '─') => ch.repeat(W);

/**
 * 主循环 CLI 过程渲染器：把无人值守的运行过程实时画到控制台。
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

  banner(cycleId: number, mode: string, trigger: string): void {
    console.log('');
    console.log(chalk.cyan(`╔${line('═')}╗`));
    const title = `  周期 #${cycleId} · ${mode} · 触发:${trigger} · ${CycleReporter.ts()}`;
    console.log(chalk.cyan('║') + chalk.bold.white(title.padEnd(W - 1)) + chalk.cyan('║'));
    console.log(chalk.cyan(`╚${line('═')}╝`));
  }

  phase(n: number, total: number, label: string): void {
    console.log(`\n${chalk.blue(`[${n}/${total}]`)} ${chalk.bold(label)} …`);
  }

  phaseDone(detail: string): void {
    console.log(`      ${chalk.green('✓')} ${chalk.gray(detail)}`);
  }

  phaseWarn(detail: string): void {
    console.log(`      ${chalk.yellow('!')} ${chalk.gray(detail)}`);
  }

  marketHeader(idx: number, total: number, question: string): void {
    const q = question.length > 52 ? question.slice(0, 49) + '…' : question;
    console.log(`  ${chalk.whiteBright(`▸ ${idx}/${total}`)} ${q}`);
  }

  marketStep(text: string): void {
    console.log(`      ${chalk.gray('·')} ${chalk.gray(text)}`);
  }

  marketSkip(reason: string): void {
    const short = reason.length > 60 ? reason.slice(0, 57) + '…' : reason;
    console.log(`      ${chalk.yellow('⊘ SKIP')} ${chalk.dim(short)}`);
  }

  betLine(detail: string): void {
    console.log(`      ${chalk.green('★ BET')}  ${chalk.green(detail)}`);
  }

  rejectedLine(detail: string): void {
    console.log(`      ${chalk.red('✗ 风控拒绝')} ${chalk.dim(detail)}`);
  }

  errorLine(text: string): void {
    console.log(`      ${chalk.red('× 错误')} ${chalk.red(text.slice(0, 80))}`);
  }

  divider(): void {
    console.log(chalk.gray(`  ${line()}`));
  }

  summary(rows: {
    scanned: number; hardPassed: number; selected: number; forecasted: number;
    bets: number; rejected: number; errors: number; skipCount: number;
    settledConditions?: number;
  }, wallet: { cashUsd: number; totalExposure: number; openPositions: number; drawdown: number }): void {
    const dur = ((Date.now() - this.start) / 1000).toFixed(0);
    const dd = (wallet.drawdown * 100).toFixed(1);
    console.log(`\n${chalk.cyan(`  ${line()}`)}`);
    console.log(chalk.bold.white('  周期摘要'));
    console.log(`  扫描 ${chalk.whiteBright(rows.scanned)} → 硬过滤 ${chalk.whiteBright(rows.hardPassed)} → 入选 ${chalk.whiteBright(rows.selected)}`);
    console.log(`  预测 ${chalk.whiteBright(rows.forecasted)} | ${chalk.green(`下注 ${rows.bets}`)} | ${chalk.yellow(`跳过 ${rows.skipCount}`)} | ${chalk.red(`拒绝 ${rows.rejected}`)} | 错误 ${rows.errors}${rows.settledConditions != null ? ` | 结算 ${rows.settledConditions}` : ''}`);
    console.log(`  现金 ${chalk.green(`$${wallet.cashUsd.toFixed(2)}`)} | 敞口 $${wallet.totalExposure.toFixed(2)} | 持仓 ${wallet.openPositions} | 回撤 ${dd}%`);
    console.log(chalk.gray(`  耗时 ${dur}s · ${CycleReporter.ts()}`));
    console.log(chalk.cyan(`  ${line()}`));
  }
}
