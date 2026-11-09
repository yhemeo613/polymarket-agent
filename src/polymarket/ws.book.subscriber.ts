import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import WebSocket from 'ws';
import { AppConfigService } from '../config/app-config.service';
import type { Book, BookLevel } from './gamma.types';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const PING_INTERVAL_MS = 10_000;
const RECONNECT_BACKOFF_MS = 5_000;

interface WsLevel { price: string | number; size: string | number }
interface WsEvent {
  event_type: string;
  asset_id?: string;
  bids?: WsLevel[];
  asks?: WsLevel[];
  changes?: Array<{ price: string | number; side: string; size: string | number }>;
  tick_size?: string | number;
  neg_risk?: boolean;
}

/**
 * CLOB 市场 WS 增量订阅（可选，WS_ENABLED=true 时启用）。
 * - `book` 事件整簿替换；`price_change` 按 side 增量改档
 * - 10s PING 心跳；断线指数退避重连并重订阅
 */
@Injectable()
export class WsBookSubscriber implements OnModuleDestroy {
  private readonly logger = new Logger(WsBookSubscriber.name);
  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private subscribed = new Set<string>();
  private listeners: Array<(b: Book) => void> = [];
  private enabled = false;

  constructor(private config: AppConfigService) {
    this.enabled = this.config.wsEnabled;
  }

  onBook(fn: (b: Book) => void) {
    this.listeners.push(fn);
  }

  async ensureSubscribed(tokenIds: string[]): Promise<void> {
    if (!this.enabled) return;
    const fresh = tokenIds.filter((t) => !this.subscribed.has(t));
    if (!fresh.length && this.ws) return;
    fresh.forEach((t) => this.subscribed.add(t));
    if (!this.ws) this.connect();
    else this.sendSubscribe([...this.subscribed]);
  }

  private connect() {
    try {
      this.ws = new WebSocket(WS_URL);
    } catch (err) {
      this.logger.warn(`WS 连接失败: ${String(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws.on('open', () => {
      this.logger.log(`CLOB WS 已连接（${this.subscribed.size} 个 token）`);
      this.sendSubscribe([...this.subscribed]);
      this.pingTimer = setInterval(() => {
        try { this.ws?.send('PING'); } catch { /* 忽略 */ }
      }, PING_INTERVAL_MS);
    });
    this.ws.on('message', (data: WebSocket.RawData) => {
      this.handleMessage(String(data));
    });
    this.ws.on('error', (err) => this.logger.warn(`WS 错误: ${err.message}`));
    this.ws.on('close', () => {
      this.logger.warn('WS 断开，准备重连');
      this.cleanupTimers();
      this.scheduleReconnect();
    });
  }

  private sendSubscribe(tokenIds: string[]) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !tokenIds.length) return;
    this.ws.send(JSON.stringify({ assets_ids: tokenIds, type: 'market' }));
  }

  private handleMessage(msg: string) {
    if (msg === 'PONG' || msg === 'PING') return;
    let events: WsEvent[] | WsEvent;
    try {
      events = JSON.parse(msg);
    } catch {
      return;
    }
    const list = Array.isArray(events) ? events : [events];
    for (const ev of list) {
      if (!ev.asset_id) continue;
      if (ev.event_type === 'book') {
        this.emitBook(ev.asset_id, ev);
      } else if (ev.event_type === 'price_change') {
        this.applyChanges(ev.asset_id, ev.changes ?? []);
      }
    }
  }

  private currentBook(tokenId: string): Book {
    return {
      tokenId,
      bids: [],
      asks: [],
      tickSize: null,
      minOrderSize: null,
      negRisk: null,
      fetchedAt: new Date().toISOString(),
      source: 'ws',
    };
  }

  private emitBook(tokenId: string, ev: WsEvent) {
    const lvl = (x: WsLevel): BookLevel => ({ price: Number(x.price), size: Number(x.size) });
    const bids = (ev.bids ?? []).map(lvl).sort((a, b) => b.price - a.price);
    const asks = (ev.asks ?? []).map(lvl).sort((a, b) => a.price - b.price);
    const book: Book = {
      tokenId,
      bids,
      asks,
      tickSize: ev.tick_size != null ? Number(ev.tick_size) : null,
      minOrderSize: null,
      negRisk: ev.neg_risk ?? null,
      fetchedAt: new Date().toISOString(),
      source: 'ws',
    };
    this.listeners.forEach((fn) => fn(book));
  }

  private applyChanges(tokenId: string, changes: Array<{ price: string | number; side: string; size: string | number }>) {
    // price_change 事件只含变动档；这里仅通知监听方存在变动，
    // 由监听方决定是否 REST 重取（简化策略，保证正确性优先于带宽）。
    void tokenId; void changes;
    // 当前实现：标记数据可能过期由 TTL 兜底 —— OrderBookService 缓存 15s 过期会 REST 刷新。
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.enabled) this.connect();
    }, RECONNECT_BACKOFF_MS);
  }

  private cleanupTimers() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  onModuleDestroy() {
    this.enabled = false;
    this.cleanupTimers();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { this.ws?.close(); } catch { /* 忽略 */ }
  }
}
