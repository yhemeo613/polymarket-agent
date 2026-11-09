import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import type { ForecastRow } from '../db/schema';
import type { Forecast } from '../research/forecaster.service';
import type { DecisionOutcome } from '../decision/decision.service';
import { nowIso } from '../common/hash.util';

export interface JournalInput {
  forecast: Forecast;
  decision: DecisionOutcome;
  cycleId: number | null;
}

/**
 * Forecast Journal：**所有**预测（含未下注候选）无条件落库。
 * 这是黑盒实验的核心测量仪器 —— 无 stake 的校准数据流。
 */
@Injectable()
export class ForecastJournal {
  constructor(private db: DbService) {}

  insert(input: JournalInput): number {
    const { forecast, decision, cycleId } = input;
    const bestAsk = forecast.bestAskAtCall;
    this.db.run(
      `INSERT INTO forecasts (cycle_id, ts, market_id, condition_id, event_id, question, category, end_date,
       yes_token_id, no_token_id, outcome, p_raw, p_cal, p_final, confidence, market_mid_at_call, best_ask_at_call,
       evidence_json, applied_rules_json, decision, skip_reason, status, rationale)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      cycleId, nowIso(), forecast.market.id, forecast.market.conditionId, forecast.market.eventId,
      forecast.market.question, forecast.market.category, forecast.market.endDate,
      forecast.market.yesTokenId, forecast.market.noTokenId, 'YES',
      forecast.pRaw, decision.pCal, decision.pFinal, forecast.confidence,
      forecast.marketMidAtCall, bestAsk,
      JSON.stringify({ items: forecast.evidence.items, degraded: forecast.evidence.degraded, keyFactors: forecast.keyFactors, evidenceUsed: forecast.evidenceUsed }),
      JSON.stringify(decision.appliedRules),
      decision.intent ? 'BET' : 'SKIP',
      decision.skipReason,
      'OPEN',
      forecast.rationale,
    );
    const row = this.db.get<{ id: number }>('SELECT id FROM forecasts ORDER BY id DESC LIMIT 1');
    return row?.id ?? 0;
  }

  markForecast(id: number, fields: { result: string; y: number; brierAgent: number; brierMarket: number; brierDelta: number }) {
    this.db.run(
      `UPDATE forecasts SET status = ?, result = ?, y = ?, brier_agent = ?, brier_market = ?, brier_delta = ? WHERE id = ?`,
      'SETTLED', fields.result, fields.y, fields.brierAgent, fields.brierMarket, fields.brierDelta, id,
    );
  }

  openByConditions(limit = 60): Array<{ conditionId: string; forecastId: number }> {
    const rows = this.db.all<{ conditionId: string; id: number }>(
      `SELECT DISTINCT condition_id, MIN(id) AS id FROM forecasts WHERE status = 'OPEN' GROUP BY condition_id LIMIT ?`,
      limit,
    );
    return rows.map((r) => ({ conditionId: r.conditionId, forecastId: r.id }));
  }

  forecastsByCondition(conditionId: string): ForecastRow[] {
    return this.db.all<ForecastRow>('SELECT * FROM forecasts WHERE condition_id = ?', conditionId);
  }

  settledSinceN(n: number): ForecastRow[] {
    return this.db.all<ForecastRow>(
      'SELECT * FROM forecasts WHERE status = ? AND id > ? ORDER BY id', 'SETTLED', n,
    );
  }

  counts(): { total: number; open: number; settled: number; bets: number } {
    const total = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM forecasts')?.c ?? 0;
    const open = this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM forecasts WHERE status = 'OPEN'")?.c ?? 0;
    const settled = this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM forecasts WHERE status = 'SETTLED'")?.c ?? 0;
    const bets = this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM forecasts WHERE decision = 'BET'")?.c ?? 0;
    return { total, open, settled, bets };
  }

  /** brier_delta 聚合（配对：同一条预测内 agent vs 市场价） */
  brierDeltaStats(): { n: number; mean: number; winRate: number } {
    const rows = this.db.all<{ d: number | null }>(
      'SELECT brier_delta AS d FROM forecasts WHERE status = ? AND brier_delta IS NOT NULL', 'SETTLED',
    );
    const ds = rows.map((r) => r.d).filter((d): d is number => d != null);
    if (!ds.length) return { n: 0, mean: 0, winRate: 0 };
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    const wins = ds.filter((d) => d < 0).length;
    return { n: ds.length, mean, winRate: wins / ds.length };
  }
}
