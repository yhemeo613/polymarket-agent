import { Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { AppConfigService } from '../config/app-config.service';
import type { Book, BookLevel } from './gamma.types';

interface RawBook {
  asset_id?: string;
  bids?: Array<{ price: string | number; size: string | number }>;
  asks?: Array<{ price: string | number; size: string | number }>;
  tick_size?: string | number;
  min_order_size?: string | number;
  neg_risk?: boolean;
  timestamp?: string | number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * CLOB 公共行情（无需认证）：订单簿快照。
 * 只读端点，下单走 execution 模块的 LiveBroker。
 */
@Injectable()
export class ClobMarketApi {
  private http: AxiosInstance;

  constructor(private config: AppConfigService) {
    this.http = axios.create({
      baseURL: config.clobHost,
      timeout: 10000,
      headers: { Accept: 'application/json' },
    });
  }

  /** 拉取并规范化订单簿（bids 降序 / asks 升序，best 在前） */
  async fetchBook(tokenId: string): Promise<Book> {
    const raw = await this.getWithRetry<RawBook>('/book', { token_id: tokenId });
    const lvl = (x: { price: string | number; size: string | number }): BookLevel => ({
      price: Number(x.price),
      size: Number(x.size),
    });
    const bids = (raw.bids ?? []).map(lvl).filter((l) => l.price > 0 && l.size > 0);
    const asks = (raw.asks ?? []).map(lvl).filter((l) => l.price > 0 && l.size > 0);
    bids.sort((a, b) => b.price - a.price);
    asks.sort((a, b) => a.price - b.price);
    return {
      tokenId,
      bids,
      asks,
      tickSize: raw.tick_size != null ? Number(raw.tick_size) : null,
      minOrderSize: raw.min_order_size != null ? Number(raw.min_order_size) : null,
      negRisk: raw.neg_risk ?? null,
      fetchedAt: new Date().toISOString(),
      source: 'rest',
    };
  }

  private async getWithRetry<T>(url: string, params: Record<string, string>, retries = 2): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i <= retries; i++) {
      try {
        const resp = await this.http.get<T>(url, { params });
        return resp.data;
      } catch (err) {
        lastErr = err;
        await sleep(400 * Math.pow(2, i));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`CLOB GET ${url} failed`);
  }
}
