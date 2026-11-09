import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { z } from 'zod';
import { AppConfigService } from '../config/app-config.service';
import type { MarketView, Book } from '../polymarket/gamma.types';
import { OrderBookService } from '../polymarket/orderbook.service';
import { LLM_CLIENT } from '../llm/llm.module';
import type { LlmProvider } from '../llm/llm.provider';
import { FORECAST_USER_TEMPLATE, SUPERFORECASTER_SYSTEM } from './prompts';
import { EvidenceService, EvidenceBundle } from './evidence.service';

export const ForecastOutput = z.object({
  p_yes: z.coerce.number().min(0).max(1),
  confidence: z.coerce.number().min(0).max(1).default(0.5),
  key_factors: z.array(z.string()).default([]),
  evidence_used: z.array(z.string()).default([]),
  rationale: z.string().default(''),
});

export interface Forecast {
  market: MarketView;
  pRaw: number; // LLM/baseline 原始估计（YES 侧）
  confidence: number;
  keyFactors: string[];
  evidenceUsed: string[];
  rationale: string;
  evidence: EvidenceBundle;
  marketMidAtCall: number | null;
  bestAskAtCall: number | null;
  mode: 'baseline' | 'research';
}

/**
 * superforecaster 预测层。
 * - research 模式：五步法 + 证据注入 + playbook 注入（开卷）
 * - baseline 模式（无 LLM）：p̂ = 市场中间价（H0 零假设基线，全链路照常运行）
 */
@Injectable()
export class ForecasterService {
  private readonly logger = new Logger(ForecasterService.name);

  constructor(
    private config: AppConfigService,
    private orderBook: OrderBookService,
    private evidenceService: EvidenceService,
    @Optional() @Inject(LLM_CLIENT) private llm: LlmProvider | null,
  ) {}

  async forecast(market: MarketView, book: Book | null, playbookExcerpt: string): Promise<Forecast> {
    const mid = book ? this.orderBook.midPrice(book) : market.mid;
    const bestAsk = book ? this.orderBook.bestAsk(book) : null;

    if (!this.llm) {
      // baseline：p̂ = mid，夹在 [0.01, 0.99] 防止 logit 爆炸
      const pRaw = mid == null ? 0.5 : Math.min(0.99, Math.max(0.01, mid));
      return {
        market,
        pRaw,
        confidence: 0.5,
        keyFactors: ['baseline: 市场中间价（H0 零假设基线）'],
        evidenceUsed: [],
        rationale: 'baseline 模式：p̂ = 市场中间价（无 LLM 参与）',
        evidence: { items: [], degraded: true },
        marketMidAtCall: mid,
        bestAskAtCall: bestAsk,
        mode: 'baseline',
      };
    }

    const evidence = await this.evidenceService.gather(market);
    const yesBid = book ? this.orderBook.bestBid(book) : null;
    const user = FORECAST_USER_TEMPLATE({
      question: market.question,
      category: market.category,
      endDate: market.endDate,
      yesBid,
      yesAsk: bestAsk,
      mid,
      negRisk: market.negRisk,
    })
      .replace(
        '{EVIDENCE}',
        evidence.items.length
          ? evidence.items.map((e, i) => `[${i + 1}] (${e.source}) ${e.title} — ${e.snippet}`).join('\n')
          : '（无外部证据，本预测为闭卷模式 —— 请主要依赖基准率与市场定价）',
      )
      .replace('{PLAYBOOK}', playbookExcerpt || '（暂无）');

    const out = await this.llm.chatJSON({
      system: SUPERFORECASTER_SYSTEM,
      user,
      schema: ForecastOutput,
    });
    const pRaw = Math.min(0.99, Math.max(0.01, out.p_yes));
    return {
      market,
      pRaw,
      confidence: out.confidence,
      keyFactors: out.key_factors,
      evidenceUsed: out.evidence_used,
      rationale: out.rationale,
      evidence,
      marketMidAtCall: mid,
      bestAskAtCall: bestAsk,
      mode: 'research',
    };
  }
}
