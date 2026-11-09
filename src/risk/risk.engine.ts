import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { KillSwitchService } from './kill-switch.service';
import { RegimeService, REGIME_MULTIPLIER } from './regime.service';
import { PortfolioService } from '../portfolio/portfolio.service';
import { LedgerService } from '../audit/ledger.service';
import type { TradeIntent } from '../decision/decision.service';

export interface RiskVerdict {
  approved: boolean;
  sizeUsd: number;
  regime: string;
  rejections: string[];
  clamps: string[];
  snapshot: {
    cashUsd: number;
    totalExposure: number;
    openPositions: number;
    drawdown: number;
    dailyPnl: number;
  };
}

/**
 * 预交易风控引擎（单一入口，paper/live 共用同一闸门）。
 * 顺序闸门：kill switch → 回撤熔断 → 日亏熔断 → regime(extreme 停机)
 *   → 单笔帽 → 单市场集中度 → 事件集中度 → 总敞口 → 持仓数 → 现金。
 * 任何裁决（过/不过）都写 ledger 审计。
 */
@Injectable()
export class RiskEngine {
  private readonly logger = new Logger(RiskEngine.name);

  constructor(
    private config: AppConfigService,
    private killSwitch: KillSwitchService,
    private regimeService: RegimeService,
    private portfolio: PortfolioService,
    private ledger: LedgerService,
  ) {}

  async validate(intent: TradeIntent): Promise<RiskVerdict> {
    const rejections: string[] = [];
    const clamps: string[] = [];
    this.portfolio.rollDayIfNeeded();

    // 1) kill switch（下单路径哨兵检查，await 后由调用方再复查一次）
    if (this.killSwitch.engaged()) {
      rejections.push('kill_switch');
    }

    const wallet = this.portfolio.getWallet();
    const exposure = this.portfolio.exposure();
    const drawdown = this.portfolio.drawdown();
    const dailyPnl = this.portfolio.dailyPnl();
    const regimeOut = this.regimeService.compute();
    const bankroll = this.config.bankrollUsd;

    // 2) 峰值回撤熔断
    if (drawdown >= this.config.drawdownHalt) {
      rejections.push(`drawdown_halt(${(drawdown * 100).toFixed(1)}%>=${(this.config.drawdownHalt * 100).toFixed(0)}%)`);
    }
    // 3) 日亏熔断
    if (dailyPnl <= -this.config.dailyLossHalt * bankroll) {
      rejections.push(`daily_loss_halt(${dailyPnl.toFixed(2)})`);
    }
    // 4) regime：extreme 直接停机
    if (regimeOut.regime === 'extreme') {
      rejections.push('regime_extreme');
    }

    let sizeUsd = intent.sizeUsd;

    // 5) 单笔帽（clamp 到帽内而非拒绝 —— Kelly 可能自然超帽）
    const singleCap = this.config.maxSinglePct * bankroll;
    if (sizeUsd > singleCap) {
      clamps.push(`single_cap:${sizeUsd.toFixed(2)}→${singleCap.toFixed(2)}`);
      sizeUsd = singleCap;
    }

    // 6) regime 乘数
    if (!rejections.length && REGIME_MULTIPLIER[regimeOut.regime] !== 1.0) {
      const mult = REGIME_MULTIPLIER[regimeOut.regime];
      const adjusted = sizeUsd * mult;
      clamps.push(`regime_${regimeOut.regime}:${sizeUsd.toFixed(2)}→${adjusted.toFixed(2)}`);
      sizeUsd = adjusted;
      sizeUsd = Math.min(sizeUsd, singleCap); // 乘数后仍不超帽
    }

    // 7) 单市场集中度
    const marketExposure = exposure.byMarket.get(intent.conditionId) ?? 0;
    if (marketExposure + sizeUsd > this.config.maxMarketPct * bankroll) {
      rejections.push(`market_concentration(${marketExposure.toFixed(2)}+${sizeUsd.toFixed(2)})`);
    }
    // 8) 事件集中度
    if (intent.eventId) {
      const eventExposure = exposure.byEvent.get(intent.eventId) ?? 0;
      if (eventExposure + sizeUsd > this.config.maxOpenPerEvent * this.config.maxMarketPct * bankroll) {
        rejections.push(`event_concentration(${eventExposure.toFixed(2)})`);
      }
    }
    // 9) 总敞口
    if (exposure.total + sizeUsd > this.config.maxTotalPct * bankroll) {
      rejections.push(`total_exposure(${exposure.total.toFixed(2)}+${sizeUsd.toFixed(2)})`);
    }
    // 10) 持仓数
    if (exposure.count >= this.config.maxPositions) {
      rejections.push(`max_positions(${exposure.count})`);
    }
    // 11) 现金
    if (wallet.cashUsd < sizeUsd) {
      rejections.push(`insufficient_cash(${wallet.cashUsd.toFixed(2)}<${sizeUsd.toFixed(2)})`);
    }

    const verdict: RiskVerdict = {
      approved: rejections.length === 0 && sizeUsd >= 1,
      sizeUsd,
      regime: regimeOut.regime,
      rejections,
      clamps,
      snapshot: {
        cashUsd: wallet.cashUsd,
        totalExposure: exposure.total,
        openPositions: exposure.count,
        drawdown,
        dailyPnl,
      },
    };

    this.ledger.append('risk_verdict', {
      requestId: intent.requestId,
      marketId: intent.marketId,
      approved: verdict.approved,
      rejections,
      clamps,
      sizeUsd,
      snapshot: verdict.snapshot,
    }, intent.requestId);
    if (!verdict.approved) {
      this.logger.log(`风控拒绝 ${intent.requestId}: ${rejections.join('; ')}`);
    }
    return verdict;
  }
}
