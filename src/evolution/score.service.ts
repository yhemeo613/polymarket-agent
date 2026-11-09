import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import type { ForecastRow } from '../db/schema';

export interface CalibrationBucket {
  lo: number; hi: number; n: number; meanP: number; hitRate: number; bias: number;
}

export interface ScoreSummary {
  settled: number;
  meanBrierAgent: number;
  meanBrierMarket: number;
  brierDelta: number;
  brierDeltaWins: number; // delta<0 的占比
  luckZ: number | null;
  bets: { n: number; roi: number | null; realizedPnl: number };
  calibration: CalibrationBucket[];
}

/**
 * 评分层（黑盒实验的统计仪表盘）：
 * - brier_delta（配对，核心指标）
 * - 幸运 z 分数（区分"估计错"与"方差击中"）
 * - 10 桶校准表（reliability 数据）
 * - 下注 ROI
 */
@Injectable()
export class ScoreService {
  constructor(private db: DbService) {}

  summary(): ScoreSummary {
    const settledRows = this.db.all<ForecastRow>(
      'SELECT * FROM forecasts WHERE status = ? AND y IS NOT NULL', 'SETTLED',
    );
    const n = settledRows.length;
    const brierAgent = settledRows.reduce((a, f) => a + (f.brierAgent ?? 0), 0);
    const brierMarket = settledRows.reduce((a, f) => a + (f.brierMarket ?? 0), 0);
    const deltas = settledRows.map((f) => f.brierDelta ?? 0);
    const brierDelta = n ? deltas.reduce((a, b) => a + b, 0) / n : 0;
    const wins = deltas.filter((d) => d < 0).length;

    // 幸运 z（仅对下注的已结算预测）：z = (胜场 − Σp) / √(Σp(1−p))
    const betRows = settledRows.filter((f) => f.decision === 'BET');
    let luckZ: number | null = null;
    if (betRows.length >= 5) {
      const pSum = betRows.reduce((a, f) => a + (f.pFinal ?? 0.5), 0);
      const winsBets = betRows.filter((f) => (f.y ?? 0) === 1).length;
      const varSum = betRows.reduce((a, f) => {
        const p = f.pFinal ?? 0.5;
        return a + p * (1 - p);
      }, 0);
      luckZ = varSum > 0 ? (winsBets - pSum) / Math.sqrt(varSum) : 0;
    }

    // 下注 ROI（已实现）
    const pnlRow = this.db.get<{ pnl: number | null }>(
      'SELECT SUM(realized_pnl) AS pnl FROM positions WHERE status = ? AND realized_pnl IS NOT NULL', 'CLOSED',
    );
    const realizedPnl = pnlRow?.pnl ?? 0;
    const costRow = this.db.get<{ cost: number | null }>(
      'SELECT SUM(cost_usd) AS cost FROM positions WHERE status = ?', 'CLOSED',
    );
    const closedCost = costRow?.cost ?? 0;

    return {
      settled: n,
      meanBrierAgent: n ? brierAgent / n : 0,
      meanBrierMarket: n ? brierMarket / n : 0,
      brierDelta,
      brierDeltaWins: n ? wins / n : 0,
      luckZ,
      bets: {
        n: betRows.length,
        roi: closedCost > 0 ? realizedPnl / closedCost : null,
        realizedPnl,
      },
      calibration: this.calibrationBuckets(settledRows),
    };
  }

  /** 10 桶校准表：各桶 p̂ 均值 vs 实现频率 */
  calibrationBuckets(rows: ForecastRow[]): CalibrationBucket[] {
    const buckets: CalibrationBucket[] = [];
    for (let i = 0; i < 10; i++) {
      const lo = i / 10;
      const hi = (i + 1) / 10;
      const inBucket = rows.filter((f) => {
        const p = f.pFinal ?? f.pCal;
        return p != null && p >= lo && (p < hi || (i === 9 && p <= 1));
      });
      const k = inBucket.length;
      const meanP = k ? inBucket.reduce((a, f) => a + (f.pFinal ?? f.pCal ?? 0), 0) / k : 0;
      const hitRate = k ? inBucket.reduce((a, f) => a + (f.y ?? 0), 0) / k : 0;
      buckets.push({ lo, hi, n: k, meanP, hitRate, bias: k ? hitRate - meanP : 0 });
    }
    return buckets;
  }

  /** 阈值扫描：对每个 min_edge 候选做反事实平注 ROI（已结算预测上） */
  thresholdSweep(): Array<{ minEdge: number; n: number; flatBetRoi: number | null }> {
    // edge 未单独持久化 —— 反事实扫描基于 p_final − best_ask_at_call 近似
    const all = this.db.all<ForecastRow>(
      'SELECT * FROM forecasts WHERE status = ? AND y IS NOT NULL AND p_final IS NOT NULL AND best_ask_at_call IS NOT NULL',
      'SETTLED',
    );
    const out: Array<{ minEdge: number; n: number; flatBetRoi: number | null }> = [];
    for (const minEdge of [0.01, 0.02, 0.03, 0.05, 0.08]) {
      const pick = all.filter((f) => (f.pFinal as number) - (f.bestAskAtCall as number) >= minEdge);
      const n = pick.length;
      let roi: number | null = null;
      if (n > 0) {
        // 平注 1 USD 买 YES：盈亏 = y·(1/ask) − 1
        const pnl = pick.reduce((a, f) => {
          const ask = Math.max(f.bestAskAtCall as number, 0.01);
          return a + ((f.y ?? 0) === 1 ? 1 / ask - 1 : -1);
        }, 0);
        roi = pnl / n;
      }
      out.push({ minEdge, n, flatBetRoi: roi });
    }
    return out;
  }
}
