import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { OrderBookService } from '../polymarket/orderbook.service';
import { takerFeeRate } from '../polymarket/fees';
import type { MarketView, Book } from '../polymarket/gamma.types';
import { CalibrationService } from './calibration.service';
import { RulesService } from './rules.service';
import { computeEdge } from './edge.calculator';
import { kellySize } from './kelly.sizer';
import { newRequestId } from '../common/hash.util';

export interface TradeIntent {
  requestId: string;
  marketId: string;
  conditionId: string;
  eventId: string | null;
  question: string;
  category: string | null;
  tokenId: string;
  side: 'BUY';
  outcome: 'YES';
  pFinal: number;
  pCal: number;
  edge: number;
  sizeUsd: number;
  limitPrice: number; // 参考价（best ask）
  takerRate: number;
  slippagePct: number;
  appliedRules: Array<{ name: string; before: number; after: number }>;
}

export interface DecisionOutcome {
  intent: TradeIntent | null;
  skipReason: string | null;
  pCal: number;
  pFinal: number;
  appliedRules: TradeIntent['appliedRules'];
  excluded: boolean;
  excludeReason?: string;
  edge: number | null;
}

/**
 * 决策层编排（确定性）：校准 → 在册规则 → edge → Kelly。
 * 任何不满足最小 edge / 仓位过小 / 规则排除 都以 SKIP + 理由落 journal。
 */
@Injectable()
export class DecisionService {
  constructor(
    private config: AppConfigService,
    private orderBook: OrderBookService,
    private calibration: CalibrationService,
    private rules: RulesService,
  ) {}

  async evaluate(
    market: MarketView,
    pRaw: number,
    book: Book | null,
  ): Promise<DecisionOutcome> {
    const pCal = this.calibration.calibrate(pRaw);
    const rulesOut = this.rules.apply(pCal, market);
    const fail = (skipReason: string, edge: number | null = null): DecisionOutcome => ({
      intent: null,
      skipReason,
      pCal,
      pFinal: rulesOut.pFinal,
      appliedRules: rulesOut.applied,
      excluded: rulesOut.excluded,
      excludeReason: rulesOut.excludeReason,
      edge,
    });

    if (rulesOut.excluded) return fail(rulesOut.excludeReason ?? 'rule_excluded');
    if (!book || this.orderBook.isPlaceholder(book)) return fail('no_book_or_placeholder');
    const bestAsk = this.orderBook.bestAsk(book);
    if (bestAsk == null || bestAsk <= 0 || bestAsk >= 1) return fail('invalid_ask');

    const takerRate = takerFeeRate(market.category, this.config.takerFeeDefault);
    // 滑点估计用典型仓位（单笔硬帽）做参照
    const nominalUsd = this.config.bankrollUsd * this.config.maxSinglePct;
    const slippagePct = this.orderBook.slippageEstimate(book, nominalUsd) + this.config.slippageBufferPct;

    const edgeOut = computeEdge({ pFinal: rulesOut.pFinal, price: bestAsk, takerRate, slippagePct });
    if (edgeOut.edge.toNumber() < this.config.minEdge) {
      return fail(`edge_insufficient(edge=${edgeOut.edge.toFixed(4)}, min=${this.config.minEdge})`);
    }

    const kelly = kellySize({
      pFinal: rulesOut.pFinal,
      price: bestAsk,
      bankrollUsd: this.config.bankrollUsd,
      fraction: this.config.kellyFraction,
      maxSinglePct: this.config.maxSinglePct,
    });
    if (kelly.sizeUsd.lessThan(1)) return fail('size_too_small');

    const intent: TradeIntent = {
      requestId: newRequestId(),
      marketId: market.id,
      conditionId: market.conditionId,
      eventId: market.eventId,
      question: market.question,
      category: market.category,
      tokenId: market.yesTokenId as string,
      side: 'BUY',
      outcome: 'YES',
      pFinal: rulesOut.pFinal,
      pCal,
      edge: edgeOut.edge.toNumber(),
      sizeUsd: kelly.sizeUsd.toNumber(),
      limitPrice: bestAsk,
      takerRate,
      slippagePct,
      appliedRules: rulesOut.applied,
    };
    return {
      intent,
      skipReason: null,
      pCal,
      pFinal: rulesOut.pFinal,
      appliedRules: rulesOut.applied,
      excluded: false,
      edge: intent.edge,
    };
  }
}
