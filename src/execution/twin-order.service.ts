import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { KillSwitchService } from '../risk/kill-switch.service';
import { PortfolioService } from '../portfolio/portfolio.service';
import { LedgerService } from '../audit/ledger.service';
import { DbService } from '../db/db.service';
import { LiveBroker } from './live.broker';
import type { TradeIntent } from '../decision/decision.service';

const TWIN_USD = 1; // 孪生单固定 $1（phil 机制：度量 paper↔真实成交质量偏差）

/**
 * 孪生单服务（P2 阶段实验仪器，默认关闭）。
 * 每笔 paper 成交信号同步下 $1 真实单，持续度量"纸面模拟 vs 真实成交"偏差。
 * 惰性构造 LiveBroker：TWIN_ORDERS=false 或无私钥时永不实例化。
 */
@Injectable()
export class TwinOrderService {
  private readonly logger = new Logger(TwinOrderService.name);
  private live: LiveBroker | null = null;

  constructor(
    private config: AppConfigService,
    private portfolio: PortfolioService,
    private ledger: LedgerService,
    private db: DbService,
    private killSwitch: KillSwitchService,
  ) {}

  private ensureLive(): LiveBroker | null {
    if (!this.config.twinOrders) return null;
    if (!this.config.walletPrivateKey) return null;
    if (!this.live) {
      this.live = new LiveBroker(
        { ...this.config, paperOnly: false } as AppConfigService,
        this.portfolio, this.ledger, this.db, this.killSwitch,
      );
      this.logger.warn('孪生单已启用 —— 每笔 paper 信号将同步 $1 真实下单');
    }
    return this.live;
  }

  async mirror(intent: TradeIntent, forecastId: number | null, cycleId: number | null): Promise<void> {
    const live = this.ensureLive();
    if (!live) return;
    if (this.killSwitch.engagedTwiceVerified()) return;
    const twinIntent: TradeIntent = {
      ...intent,
      requestId: `twin-${intent.requestId}`,
      sizeUsd: TWIN_USD,
    };
    try {
      const res = await live.execute({ intent: twinIntent, forecastId, cycleId });
      this.ledger.append('twin_order', {
        requestId: intent.requestId,
        status: res.status,
        filledShares: res.filledShares,
        avgFillPrice: res.avgFillPrice,
        paperLimit: intent.limitPrice,
        slippageDeviation: res.avgFillPrice != null ? res.avgFillPrice - intent.limitPrice : null,
      }, twinIntent.requestId);
    } catch (err) {
      this.logger.warn(`孪生单失败 ${intent.requestId}: ${String(err).slice(0, 160)}`);
    }
  }
}
