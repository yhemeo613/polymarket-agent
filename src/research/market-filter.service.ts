import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { z } from 'zod';
import { AppConfigService } from '../config/app-config.service';
import { GammaApi, } from '../polymarket/gamma.api';
import type { MarketView } from '../polymarket/gamma.types';
import { LLM_CLIENT } from '../llm/llm.module';
import type { LlmProvider } from '../llm/llm.provider';
import { SCREEN_SYSTEM, SCREEN_USER_TEMPLATE } from './prompts';
import { EvidenceService } from './evidence.service';

const ScreenOut = z.object({ pass: z.array(z.number().int()).default([]) });

export interface FilterResult {
  selected: MarketView[];
  hardPassed: number;
  llmScreened: boolean;
}

/**
 * 市场筛选流水线：
 * 硬过滤（确定性）→ 按量排序 → LLM 语义筛选（无 key 时直通 top-K，baseline 模式）。
 */
@Injectable()
export class MarketFilterService {
  private readonly logger = new Logger(MarketFilterService.name);

  constructor(
    private config: AppConfigService,
    private gamma: GammaApi,
    @Optional() @Inject(LLM_CLIENT) private llm: LlmProvider | null,
    private evidence: EvidenceService,
  ) {}

  /** 硬过滤：流动性/成交量/期限窗/品类黑名单/token 完整性 */
  hardFilter(markets: MarketView[]): MarketView[] {
    const black = new Set(this.config.blacklistCategories);
    return markets.filter((m) => {
      if (!m.yesTokenId || !m.noTokenId || !m.conditionId) return false;
      if (m.liquidity < this.config.minLiquidity) return false;
      if (m.volume24h < this.config.minVolume24h) return false;
      const days = GammaApi.daysToEnd(m);
      if (!Number.isFinite(days)) return false;
      if (days < this.config.minDaysToEnd || days > this.config.maxDaysToEnd) return false;
      const cat = (m.category ?? '').toLowerCase();
      if (cat && [...black].some((b) => cat.includes(b))) return false;
      if (m.mid == null || m.mid <= 0.005 || m.mid >= 0.995) return false; // 已近确定的市场无意义
      return true;
    });
  }

  private static rankScore(m: MarketView): number {
    // 简单排序分：24h 量为主，流动性为辅（封顶防单点支配）
    return Math.min(m.volume24h, 200_000) + Math.min(m.liquidity, 50_000) * 0.5;
  }

  /**
   * 完整筛选：扫描结果 → 硬过滤 → 排序 → （LLM）语义筛选 → topK。
   * baseline 模式（llm=null）跳过语义筛选直接取 topK。
   */
  async select(markets: MarketView[]): Promise<FilterResult> {
    const passed = this.hardFilter(markets);
    passed.sort((a, b) => MarketFilterService.rankScore(b) - MarketFilterService.rankScore(a));
    const ranked = passed.slice(0, Math.max(this.config.screenTopK * 5, 30));
    let selected = ranked.slice(0, this.config.screenTopK);
    let llmScreened = false;

    if (this.llm && ranked.length > this.config.screenTopK) {
      try {
        const lines = ranked.map((m) => `${m.question} [${m.category ?? '未知'}] 截止:${m.endDate ?? '未知'}`);
        const out = await this.llm.chatJSON({
          system: SCREEN_SYSTEM,
          user: SCREEN_USER_TEMPLATE(lines),
          schema: ScreenOut,
          maxTokens: 300,
        });
        const allowed = new Set(out.pass.filter((i) => i >= 1 && i <= ranked.length).map((i) => i - 1));
        const filtered = ranked.filter((_, idx) => allowed.has(idx));
        if (filtered.length >= Math.min(3, ranked.length)) {
          selected = filtered.slice(0, this.config.screenTopK);
          llmScreened = true;
        }
      } catch (err) {
        this.logger.warn(`LLM 语义筛选失败，回退排序直通: ${String(err)}`);
      }
    }
    return { selected, hardPassed: passed.length, llmScreened };
  }
}
