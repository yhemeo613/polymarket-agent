import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { KillSwitchService } from '../risk/kill-switch.service';
import { PortfolioService } from '../portfolio/portfolio.service';
import { ForecastJournal } from '../forecast/forecast.journal';
import { ScoreService } from '../evolution/score.service';
import { LedgerService } from '../audit/ledger.service';
import { DbService } from '../db/db.service';

/**
 * Ops 状态聚合（无 UI，JSON API）：
 * 运行模式、kill switch、资金/回撤、预测与评分统计、最后周期、账本完整性。
 */
@Injectable()
export class StatusService {
  constructor(
    private config: AppConfigService,
    private killSwitch: KillSwitchService,
    private portfolio: PortfolioService,
    private journal: ForecastJournal,
    private score: ScoreService,
    private ledger: LedgerService,
    private db: DbService,
  ) {}

  snapshot() {
    const wallet = this.portfolio.getWallet();
    const exposure = this.portfolio.exposure();
    const regimeDrawdown = this.portfolio.drawdown();
    const scoreSummary = this.score.summary();
    const lastCycle = this.db.get<{ id: number; startedAt: string; finishedAt: string | null; mode: string; trigger: string; summaryJson: string | null }>(
      'SELECT id, started_at, finished_at, mode, trigger, summary_json FROM cycles ORDER BY id DESC LIMIT 1',
    );
    const openPositions = this.portfolio.openPositions().map((p) => ({
      id: p.id,
      question: p.question,
      shares: p.shares,
      avgPrice: p.avgPrice,
      costUsd: p.costUsd,
      conditionId: p.conditionId,
      openedTs: p.openedTs,
    }));
    return {
      mode: {
        llm: this.config.llmEnabled ? 'research' : 'baseline',
        broker: this.config.paperOnly ? 'paper' : 'live',
        twinOrders: this.config.twinOrders,
      },
      killSwitch: this.killSwitch.engaged(),
      wallet: {
        cashUsd: wallet.cashUsd,
        bankroll: this.config.bankrollUsd,
        totalExposure: exposure.total,
        openPositions: exposure.count,
        peakEquity: wallet.peakEquity,
        drawdown: regimeDrawdown,
        dailyPnl: this.portfolio.dailyPnl(),
      },
      forecasts: this.journal.counts(),
      score: scoreSummary,
      lastCycle,
      openPositions,
      ledgerVerify: this.ledger.verify(),
    };
  }
}
