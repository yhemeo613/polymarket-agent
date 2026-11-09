import { Injectable, Logger } from '@nestjs/common';
import { GammaApi } from '../polymarket/gamma.api';
import { PortfolioService } from '../portfolio/portfolio.service';
import { ForecastJournal } from './forecast.journal';
import { ShadowPromotionService } from '../evolution/shadow.promotion.service';
import { CalibrationService } from '../decision/calibration.service';
import { LedgerService } from '../audit/ledger.service';
import { DbService } from '../db/db.service';
import { newRequestId } from '../common/hash.util';

/**
 * 结算守护：拉取 Gamma 已结算市场 → 回填 forecast（y/brier/brier_delta）
 * → 按结算价值平掉对应 paper 持仓 → 更新影子规则配对统计 → 校准重拟合。
 * 幂等：settlements 表 condition_id 主键 + INSERT OR IGNORE。
 */
@Injectable()
export class SettleService {
  private readonly logger = new Logger(SettleService.name);

  constructor(
    private gamma: GammaApi,
    private journal: ForecastJournal,
    private portfolio: PortfolioService,
    private shadow: ShadowPromotionService,
    private calibration: CalibrationService,
    private ledger: LedgerService,
    private db: DbService,
  ) {}

  async settlePending(limit = 40): Promise<{ settledConditions: number; forecastsSettled: number; positionsClosed: number }> {
    const pending = this.journal.openByConditions(limit);
    let settledConditions = 0;
    let forecastsSettled = 0;
    let positionsClosed = 0;

    for (const { conditionId } of pending) {
      let view;
      try {
        view = await this.gamma.fetchMarketByCondition(conditionId);
      } catch (err) {
        this.logger.warn(`结算查询失败 ${conditionId.slice(0, 10)}…: ${String(err).slice(0, 120)}`);
        continue;
      }
      if (!view) continue;
      const result = GammaApi.resolveResult(view);
      if (!result) continue; // 未结算

      // 幂等落 settlements
      const already = this.db.get<{ condition_id: string }>(
        'SELECT condition_id FROM settlements WHERE condition_id = ?', conditionId,
      );
      if (!already) {
        this.db.run(
          'INSERT OR IGNORE INTO settlements (condition_id, market_id, question, result, resolved_at, source, joined_ts) VALUES (?,?,?,?,?,?,?)',
          conditionId, view.id, view.question, result, view.endDate, 'gamma', new Date().toISOString(),
        );
      }
      settledConditions++;

      // 回填该 condition 的全部 forecast
      const forecasts = this.journal.forecastsByCondition(conditionId);
      for (const f of forecasts) {
        if (f.status === 'SETTLED') continue;
        const y = result === 'YES' ? 1 : 0;
        const pAgent = f.pFinal ?? f.pCal ?? f.pRaw ?? 0.5;
        const pMarket = f.marketMidAtCall ?? 0.5;
        const brierAgent = (pAgent - y) ** 2;
        const brierMarket = (pMarket - y) ** 2;
        this.journal.markForecast(f.id, {
          result, y, brierAgent, brierMarket,
          brierDelta: brierAgent - brierMarket,
        });
        forecastsSettled++;
      }

      // 平掉该 condition 的持仓（按结算价值：YES→1 / NO→0）
      for (const p of this.portfolio.openByCondition(conditionId)) {
        const value = p.outcome === 'YES' ? (result === 'YES' ? 1 : 0) : (result === 'NO' ? 1 : 0);
        const proceeds = p.shares * value;
        this.portfolio.applyExit({
          position: p,
          orderId: newRequestId(),
          broker: 'PAPER',
          cycleId: null,
          fill: {
            filledShares: p.shares, avgFillPrice: value, costUsd: proceeds, fee: 0,
            status: 'FILLED', raw: { settlement: result, value },
          },
          reason: `settlement:${result}`,
        });
        this.ledger.append('settlement_close', {
          positionId: p.id, conditionId, result, value,
        }, conditionId);
        positionsClosed++;
      }

      // 影子规则配对统计更新（对每条未退役规则用本 condition 的样本）
      this.shadow.updateForCondition(conditionId, result);
    }

    // 校准层重拟合（水位变化时自动生效）
    this.calibration.fit();
    return { settledConditions, forecastsSettled, positionsClosed };
  }
}
