import { Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { AppConfigService } from '../config/app-config.service';
import type { GammaMarketRaw, MarketView } from './gamma.types';
import dayjs from 'dayjs';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Gamma API 客户端（公开只读，无需认证）。
 * Gamma 管"是什么市场"：元数据、token id、结算结果。
 */
@Injectable()
export class GammaApi {
  private http: AxiosInstance;

  constructor(private config: AppConfigService) {
    this.http = axios.create({
      baseURL: config.gammaHost,
      timeout: 15000,
      headers: { Accept: 'application/json' },
    });
  }

  /** 防御性 JSON 字段解析（Gamma 多个字段是 JSON 字符串） */
  private static parseJsonArray<T = string>(v: unknown): T[] {
    if (typeof v !== 'string') return Array.isArray(v) ? (v as T[]) : [];
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  static toView(raw: GammaMarketRaw): MarketView {
    const outcomes = GammaApi.parseJsonArray(raw.outcomes).map((s) => String(s));
    const prices = GammaApi.parseJsonArray(raw.outcomePrices).map((p) => {
      const n = Number(p);
      return Number.isFinite(n) ? n : NaN;
    });
    const tokenIds = GammaApi.parseJsonArray(raw.clobTokenIds).map((s) => String(s));
    const yesPrice = prices[0];
    const noPrice = prices[1];
    const mid =
      Number.isFinite(yesPrice) && Number.isFinite(noPrice)
        ? (yesPrice + noPrice) / 2
        : Number.isFinite(yesPrice)
          ? yesPrice
          : null;
    const num = (v: unknown): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    return {
      id: String(raw.id),
      conditionId: String(raw.conditionId ?? ''),
      eventId: raw.events?.[0]?.id != null ? String(raw.events[0].id) : null,
      question: String(raw.question ?? ''),
      category: raw.category ?? null,
      endDate: raw.endDate ?? null,
      liquidity: num(raw.liquidity),
      volume24h: num(raw.volume24hr),
      negRisk: !!raw.negRisk,
      outcomes,
      prices,
      yesTokenId: tokenIds[0] ?? null,
      noTokenId: tokenIds[1] ?? null,
      mid,
      active: !!raw.active,
      closed: !!raw.closed,
    };
  }

  /**
   * 拉取可交易市场（active + 订单簿开启 + 未关闭未归档 + 非 restricted），
   * 按 24h 交易量降序分页拉取至 scanLimit。
   */
  async fetchTradableMarkets(limit: number): Promise<MarketView[]> {
    const out: MarketView[] = [];
    const pageSize = 100;
    for (let offset = 0; offset < limit; offset += pageSize) {
      const size = Math.min(pageSize, limit - offset);
      const raws = await this.getWithRetry<GammaMarketRaw[]>('/markets', {
        active: 'true',
        closed: 'false',
        archived: 'false',
        enableOrderBook: 'true',
        order: 'volume24hr',
        ascending: 'false',
        limit: String(size),
        offset: String(offset),
      });
      if (!Array.isArray(raws) || raws.length === 0) break;
      for (const r of raws) out.push(GammaApi.toView(r));
      if (raws.length < size) break;
    }
    return out.filter((m) => m.conditionId && m.yesTokenId && m.noTokenId);
  }

  /** 按 conditionId 拉取单个市场（结算/对账用） */
  async fetchMarketByCondition(conditionId: string): Promise<MarketView | null> {
    const raws = await this.getWithRetry<GammaMarketRaw[]>('/markets', {
      condition_id: conditionId,
    });
    if (!Array.isArray(raws) || raws.length === 0) return null;
    return GammaApi.toView(raws[0]);
  }

  /**
   * 结算结果：closed 市场用 outcomePrices 判定（胜方价格=1）。
   * 返回 'YES' | 'NO' | null（未知/未结算/异常）。
   */
  static resolveResult(view: MarketView): 'YES' | 'NO' | null {
    if (!view.closed) return null;
    const [y, n] = view.prices;
    if (Number.isFinite(y) && Number.isFinite(n)) {
      if (y >= 0.999 && n <= 0.001) return 'YES';
      if (n >= 0.999 && y <= 0.001) return 'NO';
    }
    return null;
  }

  /** 距结算天数（负数=已过期） */
  static daysToEnd(view: MarketView): number {
    if (!view.endDate) return NaN;
    return dayjs(view.endDate).diff(dayjs(), 'hour') / 24;
  }

  private async getWithRetry<T>(url: string, params: Record<string, string>, retries = 2): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i <= retries; i++) {
      try {
        const resp = await this.http.get<T>(url, { params });
        return resp.data;
      } catch (err) {
        lastErr = err;
        await sleep(500 * Math.pow(2, i));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`Gamma GET ${url} failed`);
  }
}
