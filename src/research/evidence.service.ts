import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { AppConfigService } from '../config/app-config.service';
import type { MarketView } from '../polymarket/gamma.types';

export interface EvidenceItem {
  source: 'tavily';
  title: string;
  snippet: string;
  url?: string;
}

export interface EvidenceBundle {
  items: EvidenceItem[];
  degraded: boolean; // true = 无外部证据源（闭卷）
}

/**
 * 证据检索层（开卷预测的证据来源）。
 * Tavily 搜索；未配置 key 时降级为闭卷并在日志明确标注。
 */
@Injectable()
export class EvidenceService {
  private readonly logger = new Logger(EvidenceService.name);

  constructor(private config: AppConfigService) {}

  async gather(market: MarketView): Promise<EvidenceBundle> {
    if (!this.config.tavilyApiKey) {
      return { items: [], degraded: true };
    }
    const query = this.toQuery(market.question);
    const items = await this.fromTavily(query);
    return { items: items.slice(0, 8), degraded: items.length === 0 };
  }

  /** 从问题中提取检索关键词（去问号、截断） */
  private toQuery(question: string): string {
    const cleaned = question.replace(/[?？!！。,，]/g, ' ').trim();
    const words = cleaned.split(/\s+/).filter((w) => w.length > 1);
    return words.slice(0, 10).join(' ') || cleaned.slice(0, 80);
  }

  private async fromTavily(query: string): Promise<EvidenceItem[]> {
    try {
      const resp = await axios.post(
        'https://api.tavily.com/search',
        { api_key: this.config.tavilyApiKey, query, max_results: 5, search_depth: 'basic' },
        { timeout: 12_000 },
      );
      const results = (resp.data?.results ?? []) as Array<Record<string, unknown>>;
      return results.map((r) => ({
        source: 'tavily' as const,
        title: String(r.title ?? ''),
        snippet: String(r.content ?? '').slice(0, 300),
        url: r.url ? String(r.url) : undefined,
      }));
    } catch (err) {
      this.logger.warn(`Tavily 检索失败: ${String(err)}`);
      return [];
    }
  }
}
