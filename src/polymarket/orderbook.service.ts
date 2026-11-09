import { Injectable, Logger } from '@nestjs/common';
import { ClobMarketApi } from './clob.market.api';
import { WsBookSubscriber } from './ws.book.subscriber';
import { AppConfigService } from '../config/app-config.service';
import type { Book, DepthFill } from './gamma.types';
import { dec, Decimal } from '../common/decimal.util';

const CACHE_TTL_MS = 15_000;
/** 占位书判定：价差 ≥ 0.9 视为无有效盘口（phil 教训：占位书行足以翻转统计结论） */
const PLACEHOLDER_SPREAD = 0.9;

/**
 * 本地订单簿：REST 轮询 + 可选 WS 增量。
 * 所有成交计算走真实盘口深度、确定性无随机数。
 */
@Injectable()
export class OrderBookService {
  private readonly logger = new Logger(OrderBookService.name);
  private cache = new Map<string, Book>();
  private inflight = new Map<string, Promise<Book>>();

  constructor(
    private readonly clobApi: ClobMarketApi,
    private readonly wsSubscriber: WsBookSubscriber,
    private readonly config: AppConfigService,
  ) {
    if (this.config.wsEnabled) {
      this.wsSubscriber.onBook((book) => this.cache.set(book.tokenId, book));
    }
  }

  async subscribeTokens(tokenIds: string[]): Promise<void> {
    if (this.config.wsEnabled) await this.wsSubscriber.ensureSubscribed(tokenIds);
  }

  /** 取订单簿（缓存 TTL 内直读；WS 开启时优先 WS 热数据，过期则 REST 刷新） */
  async getBook(tokenId: string, forceRefresh = false): Promise<Book> {
    const cached = this.cache.get(tokenId);
    if (!forceRefresh && cached && Date.now() - Date.parse(cached.fetchedAt) < CACHE_TTL_MS) {
      return cached;
    }
    const pending = this.inflight.get(tokenId);
    if (pending) return pending;
    const p = this.clobApi
      .fetchBook(tokenId)
      .then((b) => {
        this.cache.set(tokenId, b);
        return b;
      })
      .finally(() => this.inflight.delete(tokenId));
    this.inflight.set(tokenId, p);
    return p;
  }

  /** 批量刷新（顺序小并发，避免触发限流） */
  async refreshMany(tokenIds: string[]): Promise<Map<string, Book | null>> {
    const out = new Map<string, Book | null>();
    const CONCURRENCY = 4;
    const queue = [...tokenIds];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const id = queue.shift();
        if (!id) break;
        try {
          out.set(id, await this.getBook(id, true));
        } catch (err) {
          this.logger.warn(`book 刷新失败 token=${id.slice(0, 12)}…: ${String(err)}`);
          out.set(id, null);
        }
      }
    });
    await Promise.all(workers);
    return out;
  }

  bestBid(book: Book): number | null {
    return book.bids.length ? book.bids[0].price : null;
  }

  bestAsk(book: Book): number | null {
    return book.asks.length ? book.asks[0].price : null;
  }

  midPrice(book: Book): number | null {
    const b = this.bestBid(book);
    const a = this.bestAsk(book);
    if (b == null || a == null) return null;
    return (b + a) / 2;
  }

  spread(book: Book): number | null {
    const b = this.bestBid(book);
    const a = this.bestAsk(book);
    if (b == null || a == null) return null;
    return a - b;
  }

  /** 占位书：空盘口或价差 ≥ 0.9 —— 必须剔除，否则污染统计 */
  isPlaceholder(book: Book | null | undefined): boolean {
    if (!book) return true;
    if (!book.bids.length || !book.asks.length) return true;
    const s = this.spread(book);
    return s != null && s >= PLACEHOLDER_SPREAD;
  }

  totalLiquidity(book: Book): number {
    const sum = (levels: { price: number; size: number }[]) =>
      levels.reduce((acc, l) => acc + l.price * l.size, 0);
    return sum(book.bids) + sum(book.asks);
  }

  /**
   * 深度走单（确定性）：
   * - BUY 吃 asks（价格升序），SELL 吃 bids（价格降序）
   * - 传入 usd 则按金额买满（shares = usd/price 逐档累计），传入 shares 则按份额
   * - limitPrice 为成交价上限（BUY）/下限（SELL），超限停止
   */
  depthFill(
    side: 'BUY' | 'SELL',
    book: Book,
    opts: { usd?: number; shares?: number; limitPrice?: number | null },
  ): DepthFill {
    const levels = side === 'BUY' ? book.asks : book.bids;
    const usd = opts.usd != null ? dec(opts.usd) : null;
    const sharesWanted = opts.shares != null ? dec(opts.shares) : null;
    const limit = opts.limitPrice != null ? dec(opts.limitPrice) : null;

    let filled = new Decimal(0);
    let cash = new Decimal(0);
    let exhausted = true;

    for (const level of levels) {
      const p = dec(level.price);
      const available = dec(level.size);
      if (limit) {
        if (side === 'BUY' && p.gt(limit)) { exhausted = false; break; }
        if (side === 'SELL' && p.lt(limit)) { exhausted = false; break; }
      }
      let take: Decimal;
      if (usd) {
        const budget = usd.minus(cash);
        take = Decimal.min(available, budget.div(p));
      } else if (sharesWanted) {
        take = Decimal.min(available, sharesWanted.minus(filled));
      } else {
        throw new Error('depthFill 需要 usd 或 shares 之一');
      }
      if (take.lte(0)) { exhausted = false; break; }
      filled = filled.plus(take);
      cash = cash.plus(take.mul(p));
      if (usd && cash.gte(usd.minus(new Decimal('1e-9')))) { exhausted = false; break; }
      if (sharesWanted && filled.gte(sharesWanted.minus(new Decimal('1e-9')))) { exhausted = false; break; }
    }

    return {
      requestedUsd: opts.usd ?? null,
      requestedShares: opts.shares ?? null,
      filledShares: filled.toNumber(),
      costUsd: cash.toNumber(),
      avgPrice: filled.gt(0) ? cash.div(filled).toNumber() : null,
      limitPrice: opts.limitPrice ?? null,
      exhausted,
    };
  }

  /**
   * 滑点估计（研究文档启发式，未实证验证，仅用于保守扣减）：
   * slip ≈ sqrt(size/liquidity) × 2 + spread/2
   */
  slippageEstimate(book: Book, sizeUsd: number): number {
    const liq = Math.max(this.totalLiquidity(book), 1);
    const s = this.spread(book) ?? 0.02;
    const value = Math.sqrt(sizeUsd / liq) * 2 + s / 2;
    return Math.min(Math.max(value, 0), 0.2);
  }
}
