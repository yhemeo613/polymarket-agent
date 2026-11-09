import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { WalletRow, PositionRow, OrderRow } from '../db/schema';
import { nowIso } from '../common/hash.util';

export interface FillRecord {
  filledShares: number;
  avgFillPrice: number;
  costUsd: number; // BUY=支出；SELL=收入
  fee: number;
  status: 'FILLED' | 'PARTIAL';
  raw: unknown;
}

/** 入场订单入参（执行器构造，portfolio 负责落库） */
export interface EntryOrderInput {
  id: string;
  broker: 'PAPER' | 'LIVE';
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  tokenId: string;
  limitPrice: number | null;
  sizeUsd: number | null;
  shares: number | null;
  reason: string | null;
}

/**
 * 组合记账（唯一写现金/持仓的入口，保证口径一致）。
 * paper 与 live 共用；live 模式下 FillRecord 来自回报轮询。
 */
@Injectable()
export class PortfolioService {
  constructor(private db: DbService) {}

  getWallet(): WalletRow {
    const w = this.db.get<WalletRow>('SELECT * FROM wallet WHERE id = 1');
    if (!w) throw new Error('wallet 行缺失');
    return w;
  }

  openPositions(): PositionRow[] {
    return this.db.all<PositionRow>('SELECT * FROM positions WHERE status = ? ORDER BY id', 'OPEN');
  }

  positionById(id: number): PositionRow | undefined {
    return this.db.get<PositionRow>('SELECT * FROM positions WHERE id = ?', id);
  }

  openByCondition(conditionId: string): PositionRow[] {
    return this.db.all<PositionRow>(
      'SELECT * FROM positions WHERE status = ? AND condition_id = ?',
      'OPEN', conditionId,
    );
  }

  /** 总敞口（按成本计）与单市场/单事件敞口 */
  exposure(): { total: number; byMarket: Map<string, number>; byEvent: Map<string, number>; count: number } {
    const positions = this.openPositions();
    const byMarket = new Map<string, number>();
    const byEvent = new Map<string, number>();
    let total = 0;
    for (const p of positions) {
      total += p.costUsd;
      byMarket.set(p.conditionId, (byMarket.get(p.conditionId) ?? 0) + p.costUsd);
      if (p.eventId) byEvent.set(p.eventId, (byEvent.get(p.eventId) ?? 0) + p.costUsd);
    }
    return { total, byMarket, byEvent, count: positions.length };
  }

  /** 权益 = 现金 + 持仓成本（保守口径；估值口径由 status 按最新 mid 另算） */
  equityConservative(): number {
    const w = this.getWallet();
    return w.cashUsd + this.exposure().total;
  }

  /** 跨日滚动：新的一天重置日亏锚点 */
  rollDayIfNeeded(): void {
    const w = this.getWallet();
    const today = nowIso().slice(0, 10);
    if (w.dayKey !== today) {
      const eq = this.equityConservative();
      this.db.run(
        'UPDATE wallet SET day_key = ?, day_anchor_equity = ?, updated_at = ? WHERE id = 1',
        today, eq, nowIso(),
      );
    }
  }

  dailyPnl(): number {
    const w = this.getWallet();
    return this.equityConservative() - w.dayAnchorEquity;
  }

  drawdown(): number {
    const w = this.getWallet();
    const eq = this.equityConservative();
    if (w.peakEquity <= 0) return 0;
    return Math.max(0, 1 - eq / w.peakEquity);
  }

  private updatePeak(eq: number): void {
    const w = this.getWallet();
    const peak = Math.max(w.peakEquity, eq);
    this.db.run('UPDATE wallet SET peak_equity = ?, updated_at = ? WHERE id = 1', peak, nowIso());
  }

  /** 入场：写订单 + 建/并持仓 + 扣现金（同一事务） */
  applyEntry(params: {
    order: EntryOrderInput;
    forecastId: number | null;
    cycleId: number | null;
    fill: FillRecord;
    meta: { marketId: string; conditionId: string; eventId: string | null; question: string; category: string | null; outcome: 'YES' | 'NO'; tokenId: string };
  }): PositionRow {
    const { order, fill, meta } = params;
    this.db.raw.exec('BEGIN');
    try {
      this.db.run(
        `INSERT INTO orders (id, forecast_id, cycle_id, ts, broker, kind, side, outcome, token_id, market_id, condition_id,
         limit_price, size_usd, shares, filled_shares, avg_fill_price, fee, status, reason, request_json, fill_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        order.id, params.forecastId, params.cycleId, nowIso(), order.broker, 'ENTRY', order.side, meta.outcome,
        meta.tokenId, meta.marketId, meta.conditionId, order.limitPrice ?? null, order.sizeUsd ?? null,
        order.shares ?? null, fill.filledShares, fill.avgFillPrice, fill.fee, fill.status,
        order.reason ?? null, JSON.stringify(fill.raw ?? {}), JSON.stringify(fill.raw ?? {}),
      );

      // 合并同 token 持仓（加权均价）
      const existing = this.db.all<PositionRow>(
        'SELECT * FROM positions WHERE status = ? AND token_id = ? LIMIT 1',
        'OPEN', meta.tokenId,
      );
      let position: PositionRow;
      if (existing.length) {
        const p = existing[0];
        const newShares = p.shares + fill.filledShares;
        const newCost = p.costUsd + fill.costUsd + fill.fee;
        this.db.run(
          'UPDATE positions SET shares = ?, avg_price = ?, cost_usd = ? WHERE id = ?',
          newShares, newCost / newShares, newCost, p.id,
        );
        position = { ...p, shares: newShares, avgPrice: newCost / newShares, costUsd: newCost };
      } else {
        this.db.run(
          `INSERT INTO positions (forecast_id, market_id, condition_id, event_id, question, category, outcome, token_id,
           shares, avg_price, cost_usd, status, opened_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          params.forecastId, meta.marketId, meta.conditionId, meta.eventId, meta.question, meta.category,
          meta.outcome, meta.tokenId, fill.filledShares, fill.avgFillPrice, fill.costUsd + fill.fee,
          'OPEN', nowIso(),
        );
        const row = this.db.get<{ id: number }>('SELECT id FROM positions ORDER BY id DESC LIMIT 1');
        position = {
          id: row?.id ?? 0, forecastId: params.forecastId, marketId: meta.marketId,
          conditionId: meta.conditionId, eventId: meta.eventId, question: meta.question,
          category: meta.category, outcome: meta.outcome, tokenId: meta.tokenId,
          shares: fill.filledShares, avgPrice: fill.avgFillPrice, costUsd: fill.costUsd + fill.fee,
          status: 'OPEN', openedTs: nowIso(), closedTs: null, closeReason: null, realizedPnl: null,
        };
      }

      const w = this.getWallet();
      const cash = w.cashUsd - fill.costUsd - fill.fee;
      this.db.run('UPDATE wallet SET cash_usd = ?, updated_at = ? WHERE id = 1', cash, nowIso());
      const eq = cash + this.exposure().total;
      this.updatePeak(eq);
      this.db.raw.exec('COMMIT');
      return position;
    } catch (err) {
      this.db.raw.exec('ROLLBACK');
      throw err;
    }
  }

  /** 出场（全平）：写订单 + 平仓 + 回收现金 + 已实现 PnL（同一事务） */
  applyExit(params: {
    position: PositionRow;
    orderId: string;
    broker: 'PAPER' | 'LIVE';
    cycleId: number | null;
    fill: FillRecord;
    reason: string;
    limitPrice?: number | null;
  }): number {
    const { position, fill } = params;
    this.db.raw.exec('BEGIN');
    try {
      const proceeds = fill.costUsd; // SELL 收入
      const realized = proceeds - fill.fee - position.costUsd;
      this.db.run(
        `INSERT INTO orders (id, forecast_id, cycle_id, ts, broker, kind, side, outcome, token_id, market_id, condition_id,
         limit_price, size_usd, shares, filled_shares, avg_fill_price, fee, status, reason, request_json, fill_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        params.orderId, position.forecastId, params.cycleId, nowIso(), params.broker, 'EXIT', 'SELL',
        position.outcome, position.tokenId, position.marketId, position.conditionId,
        params.limitPrice ?? null, proceeds, position.shares, fill.filledShares, fill.avgFillPrice,
        fill.fee, fill.status, params.reason, null, JSON.stringify(fill.raw ?? {}),
      );
      this.db.run(
        'UPDATE positions SET status = ?, closed_ts = ?, close_reason = ?, realized_pnl = ? WHERE id = ?',
        'CLOSED', nowIso(), params.reason, realized, position.id,
      );
      const w = this.getWallet();
      const cash = w.cashUsd + proceeds - fill.fee;
      this.db.run('UPDATE wallet SET cash_usd = ?, updated_at = ? WHERE id = 1', cash, nowIso());
      this.updatePeak(cash + this.exposure().total);
      this.db.raw.exec('COMMIT');
      return realized;
    } catch (err) {
      this.db.raw.exec('ROLLBACK');
      throw err;
    }
  }
}
