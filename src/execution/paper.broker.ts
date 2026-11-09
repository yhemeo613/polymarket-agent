import { Injectable, Logger } from '@nestjs/common';
import { OrderBookService } from '../polymarket/orderbook.service';
import { takerFeeUsd, takerFeeRate } from '../polymarket/fees';
import { PortfolioService } from '../portfolio/portfolio.service';
import { LedgerService } from '../audit/ledger.service';
import { DbService } from '../db/db.service';
import { AppConfigService } from '../config/app-config.service';
import { newRequestId } from '../common/hash.util';
import { dec } from '../common/decimal.util';
import type { Broker, ExecuteParams, ExecuteResult } from './broker.interface';

/**
 * PaperBroker：真实盘口深度走单撮合（FAK 语义，确定性无随机数）。
 * - BUY：从 best ask 逐档吃深度，直到金额耗尽或盘口耗尽
 * - 费用按 taker 费率计（保守口径，与真实吃单一致）
 * - 成交记录/现金/持仓事务更新，request_id 幂等
 */
@Injectable()
export class PaperBroker implements Broker {
  readonly name = 'PAPER' as const;
  private readonly logger = new Logger(PaperBroker.name);

  constructor(
    private config: AppConfigService,
    private orderBook: OrderBookService,
    private portfolio: PortfolioService,
    private ledger: LedgerService,
    private db: DbService,
  ) {}

  async execute(params: ExecuteParams): Promise<ExecuteResult> {
    const { intent } = params;
    // 幂等检查
    const existing = this.db.get<{ id: string; status: string; filledShares: number; avgFillPrice: number | null; fee: number; sizeUsd: number | null }>(
      'SELECT id, status, filled_shares, avg_fill_price, fee, size_usd FROM orders WHERE id = ?',
      intent.requestId,
    );
    if (existing) {
      return {
        orderId: existing.id,
        status: existing.status as ExecuteResult['status'],
        filledShares: existing.filledShares,
        avgFillPrice: existing.avgFillPrice,
        fee: existing.fee,
        costUsd: existing.sizeUsd ?? 0,
        reason: 'idempotent_replay',
      };
    }

    const book = await this.orderBook.getBook(intent.tokenId, true); // 下单前强制刷新
    if (this.orderBook.isPlaceholder(book)) {
      return this.reject(params, 'no_liquidity_placeholder_book');
    }

    const fill = this.orderBook.depthFill('BUY', book, { usd: intent.sizeUsd });
    if (fill.filledShares <= 0 || fill.avgPrice == null) {
      return this.reject(params, 'zero_fill');
    }
    const rate = takerFeeRate(intent.category, this.config.takerFeeDefault);
    const fee = takerFeeUsd(dec(fill.filledShares), dec(fill.avgPrice), rate).toNumber();
    const status: 'FILLED' | 'PARTIAL' = fill.exhausted === false && fill.filledShares > 0 ? 'FILLED' : 'PARTIAL';

    const position = this.portfolio.applyEntry({
      order: {
        id: intent.requestId,
        broker: this.name,
        side: intent.side,
        outcome: intent.outcome,
        tokenId: intent.tokenId,
        limitPrice: intent.limitPrice,
        sizeUsd: intent.sizeUsd,
        shares: null,
        reason: null,
      },
      forecastId: params.forecastId,
      cycleId: params.cycleId,
      fill: {
        filledShares: fill.filledShares,
        avgFillPrice: fill.avgPrice,
        costUsd: fill.costUsd,
        fee,
        status,
        raw: fill,
      },
      meta: {
        marketId: intent.marketId,
        conditionId: intent.conditionId,
        eventId: intent.eventId,
        question: intent.question,
        category: intent.category,
        outcome: intent.outcome,
        tokenId: intent.tokenId,
      },
    });

    this.ledger.append('paper_fill', {
      requestId: intent.requestId,
      marketId: intent.marketId,
      fill,
      fee,
      positionId: position.id,
      edge: intent.edge,
      pFinal: intent.pFinal,
    }, intent.requestId);
    this.logger.log(
      `PAPER 成交 ${fill.filledShares.toFixed(2)} 份 @ ${fill.avgPrice.toFixed(4)}（费 ${fee.toFixed(4)}）market=${intent.marketId}`,
    );

    return {
      orderId: intent.requestId,
      status,
      filledShares: fill.filledShares,
      avgFillPrice: fill.avgPrice,
      fee,
      costUsd: fill.costUsd,
      positionId: position.id,
    };
  }

  async closePosition(
    position: Parameters<Broker['closePosition']>[0],
    reason: string,
    cycleId: number | null,
  ): Promise<ExecuteResult> {
    const book = await this.orderBook.getBook(position.tokenId, true);
    if (this.orderBook.isPlaceholder(book)) {
      return this.rejectExit(position, reason, 'exit_book_dead');
    }
    const fill = this.orderBook.depthFill('SELL', book, { shares: position.shares });
    if (fill.filledShares <= 0 || fill.avgPrice == null) {
      return this.rejectExit(position, reason, 'exit_zero_fill');
    }
    const rate = takerFeeRate(position.category, this.config.takerFeeDefault);
    const fee = takerFeeUsd(dec(fill.filledShares), dec(fill.avgPrice), rate).toNumber();
    const orderId = newRequestId();
    const realized = this.portfolio.applyExit({
      position,
      orderId,
      broker: this.name,
      cycleId,
      fill: {
        filledShares: fill.filledShares,
        avgFillPrice: fill.avgPrice,
        costUsd: fill.costUsd,
        fee,
        status: 'FILLED',
        raw: fill,
      },
      reason,
    });
    this.ledger.append('paper_exit', {
      orderId,
      positionId: position.id,
      reason,
      realized,
      fill,
    }, orderId);
    this.logger.log(`PAPER 平仓 ${position.tokenId.slice(0, 10)}… realized=${realized.toFixed(4)} (${reason})`);
    return {
      orderId,
      status: 'FILLED',
      filledShares: fill.filledShares,
      avgFillPrice: fill.avgPrice,
      fee,
      costUsd: fill.costUsd,
      realizedPnl: realized,
    };
  }

  private reject(params: ExecuteParams, reason: string): ExecuteResult {
    const intent = params.intent;
    this.db.run(
      `INSERT INTO orders (id, forecast_id, cycle_id, ts, broker, kind, side, outcome, token_id, market_id, condition_id,
       limit_price, size_usd, shares, filled_shares, avg_fill_price, fee, status, reason, request_json, fill_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      intent.requestId, params.forecastId, params.cycleId, new Date().toISOString(), this.name, 'ENTRY',
      intent.side, intent.outcome, intent.tokenId, intent.marketId, intent.conditionId,
      intent.limitPrice, intent.sizeUsd, null, 0, null, 0, 'REJECTED', reason, null, null,
    );
    this.ledger.append('paper_reject', { requestId: intent.requestId, reason }, intent.requestId);
    return { orderId: intent.requestId, status: 'REJECTED', filledShares: 0, avgFillPrice: null, fee: 0, costUsd: 0, reason };
  }

  private rejectExit(
    position: Parameters<Broker['closePosition']>[0],
    reason: string,
    exitReason: string,
  ): ExecuteResult {
    this.ledger.append('paper_exit_reject', { positionId: position.id, reason, exitReason });
    return { orderId: 'n/a', status: 'REJECTED', filledShares: 0, avgFillPrice: null, fee: 0, costUsd: 0, reason: exitReason };
  }
}
