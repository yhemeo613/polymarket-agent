import { Injectable, Logger } from '@nestjs/common';
import chalk from 'chalk';
import { CycleReporter } from '../cli/cycle.reporter';
import { AppConfigService } from '../config/app-config.service';
import { OrderBookService } from '../polymarket/orderbook.service';
import { PortfolioService } from '../portfolio/portfolio.service';
import { KillSwitchService } from '../risk/kill-switch.service';
import { AlertService } from '../alerting/alert.service';
import { Inject } from '@nestjs/common';
import { BROKER } from '../execution/execution.module';
import type { Broker } from '../execution/broker.interface';

/**
 * 轻触发（15 分钟）：持仓确定性守护 ——
 * mid ≥ TAKE_PROFIT_AT → 止盈平仓；mid ≤ STOP_LOSS_AT → 止损平仓。
 * 确定性规则，不经 LLM；跨日滚动日亏锚点。
 */
@Injectable()
export class LightTriggerService {
  private readonly logger = new Logger(LightTriggerService.name);

  constructor(
    private config: AppConfigService,
    private orderBook: OrderBookService,
    private portfolio: PortfolioService,
    private killSwitch: KillSwitchService,
    private alert: AlertService,
    @Inject(BROKER) private broker: Broker,
  ) {}

  async runLight(): Promise<{ checked: number; closed: number }> {
    if (this.killSwitch.engaged()) return { checked: 0, closed: 0 };
    this.portfolio.rollDayIfNeeded();
    const positions = this.portfolio.openPositions();
    let closed = 0;

    const t = CycleReporter.stamp();
    if (positions.length) {
      console.log(`\n${chalk.blue(`[轻触发 ${t}]`)} ${chalk.bold(`持仓监控（${positions.length} 个）`)}`);
    }

    for (const p of positions) {
      try {
        const book = await this.orderBook.getBook(p.tokenId, true);
        const mid = this.orderBook.midPrice(book);
        if (mid == null || this.orderBook.isPlaceholder(book)) continue;
        const label = (p.question ?? p.tokenId.slice(0, 12)).slice(0, 40);
        if (mid >= this.config.takeProfitAt) {
          await this.broker.closePosition(p, `take_profit@${mid.toFixed(3)}`, null);
          closed++;
          console.log(`  ${chalk.green('★ 止盈平仓')} ${label} · mid=${mid.toFixed(3)} 成本=${p.avgPrice.toFixed(3)}`);
          await this.alert.alert('info', `止盈平仓 ${p.question?.slice(0, 40) ?? p.tokenId.slice(0, 10)}`, `mid=${mid.toFixed(3)}`);
        } else if (mid <= this.config.stopLossAt) {
          await this.broker.closePosition(p, `stop_loss@${mid.toFixed(3)}`, null);
          closed++;
          console.log(`  ${chalk.red('★ 止损平仓')} ${label} · mid=${mid.toFixed(3)} 成本=${p.avgPrice.toFixed(3)}`);
          await this.alert.alert('warn', `止损平仓 ${p.question?.slice(0, 40) ?? p.tokenId.slice(0, 10)}`, `mid=${mid.toFixed(3)}`);
        } else {
          console.log(`  ${chalk.gray('·')} ${label} · mid=${mid.toFixed(3)}（持有，成本 ${p.avgPrice.toFixed(3)}）`);
        }
      } catch (err) {
        this.logger.warn(`持仓监控失败 #${p.id}: ${String(err).slice(0, 160)}`);
      }
    }
    if (positions.length) this.logger.log(`轻触发：检查 ${positions.length} 个持仓，平仓 ${closed}`);
    return { checked: positions.length, closed };
  }
}
