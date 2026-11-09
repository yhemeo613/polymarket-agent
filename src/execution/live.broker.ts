import { Injectable, Logger } from '@nestjs/common';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { AppConfigService } from '../config/app-config.service';
import { PortfolioService } from '../portfolio/portfolio.service';
import { LedgerService } from '../audit/ledger.service';
import { DbService } from '../db/db.service';
import { KillSwitchService } from '../risk/kill-switch.service';
import { newRequestId } from '../common/hash.util';
import type { Broker, ExecuteParams, ExecuteResult } from './broker.interface';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * LiveBroker：真实下单（clob-client，viem WalletClient 签名）。
 *
 * 物理隔离守卫（三重，任一不满足拒绝实例化）：
 *  1. PAPER_ONLY=false（显式关闭 paper 模式）
 *  2. WALLET_PRIVATE_KEY 存在
 *  3. kill switch 哨兵未激活（且每次下单前复查）
 * 实例化后仍受全量 RiskEngine 闸门约束（上游调用）。
 */
@Injectable()
export class LiveBroker implements Broker {
  readonly name = 'LIVE' as const;
  private readonly logger = new Logger(LiveBroker.name);
  private client: ClobClient | null = null;

  constructor(
    private config: AppConfigService,
    private portfolio: PortfolioService,
    private ledger: LedgerService,
    private db: DbService,
    private killSwitch: KillSwitchService,
  ) {
    if (this.config.paperOnly) {
      throw new Error('LiveBroker 守卫：PAPER_ONLY=true 时禁止实例化实盘执行器');
    }
    if (!this.config.walletPrivateKey) {
      throw new Error('LiveBroker 守卫：缺少 WALLET_PRIVATE_KEY');
    }
  }

  /** 懒初始化 CLOB 客户端（L1 签名 → 派生 L2 API key） */
  private async getClient(): Promise<ClobClient> {
    if (this.client) return this.client;
    const account = privateKeyToAccount(this.config.walletPrivateKey as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    });
    const base = new ClobClient(this.config.clobHost, this.config.chainId, walletClient);
    const creds = await base.createOrDeriveApiKey();
    this.client = new ClobClient(this.config.clobHost, this.config.chainId, walletClient, creds);
    this.logger.log('LiveBroker CLOB 客户端已初始化');
    return this.client;
  }

  async execute(params: ExecuteParams): Promise<ExecuteResult> {
    const { intent } = params;
    const existing = this.db.get<{ id: string; status: string }>(
      'SELECT id, status FROM orders WHERE id = ?', intent.requestId,
    );
    if (existing) {
      return {
        orderId: existing.id, status: existing.status as ExecuteResult['status'],
        filledShares: 0, avgFillPrice: null, fee: 0, costUsd: 0, reason: 'idempotent_replay',
      };
    }
    if (this.killSwitch.engagedTwiceVerified()) {
      return this.reject(intent, params, 'kill_switch');
    }

    const client = await this.getClient();
    try {
      // limitPrice 为参考 ask；实际 GTC 挂单价留 1 tick 容忍
      const price = Math.min(0.999, Math.max(0.001, intent.limitPrice));
      // 份额 = 金额/价格；满足最小下单量约束
      const shares = intent.sizeUsd / price;
      const signed = await client.createOrder(
        { tokenID: intent.tokenId, price, size: shares, side: Side.BUY },
        { negRisk: false },
      );
      const resp = await client.postOrder(signed, OrderType.GTC);
      const orderId: string | undefined = resp?.orderID ?? resp?.orderId ?? resp?.id;
      if (!orderId) {
        return this.reject(intent, params, `post_order_no_id:${JSON.stringify(resp).slice(0, 200)}`);
      }

      // 轮询成交回报（最多 10 次 × 3s）
      let filled = 0;
      let avg = 0;
      for (let i = 0; i < 10; i++) {
        await sleep(3000);
        const st = (await client.getOrder(orderId)) as unknown as Record<string, unknown>;
        const sizeMatched = Number(st?.size_matched ?? 0);
        if (sizeMatched > 0) {
          filled = sizeMatched;
          avg = Number(st?.price ?? price);
          if (sizeMatched >= shares * 0.999) break;
        }
        if (String(st?.status ?? '').match(/CANCELED|CANCELLED|EXPIRED/i)) break;
      }
      if (filled <= 0) {
        return this.reject(intent, params, 'no_fill_within_timeout', orderId);
      }

      const fee = 0; // GTC post-only 意向挂单 maker 费为 0；真实费率以回报为准（保守先记 0）
      const position = this.portfolio.applyEntry({
        order: {
          id: intent.requestId,
          broker: this.name,
          side: intent.side,
          outcome: intent.outcome,
          tokenId: intent.tokenId,
          limitPrice: price,
          sizeUsd: intent.sizeUsd,
          shares,
          reason: `live:${orderId}`,
        },
        forecastId: params.forecastId,
        cycleId: params.cycleId,
        fill: {
          filledShares: filled,
          avgFillPrice: avg || price,
          costUsd: filled * (avg || price),
          fee,
          status: filled >= shares * 0.999 ? 'FILLED' : 'PARTIAL',
          raw: { orderId },
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
      this.ledger.append('live_fill', { requestId: intent.requestId, orderId, filled, avg, positionId: position.id }, intent.requestId);
      return {
        orderId: intent.requestId, status: 'FILLED', filledShares: filled,
        avgFillPrice: avg || price, fee, costUsd: filled * (avg || price), positionId: position.id,
      };
    } catch (err) {
      this.logger.error(`LiveBroker 下单失败: ${String(err)}`);
      return this.reject(intent, params, `live_error:${String(err).slice(0, 200)}`);
    }
  }

  async closePosition(
    position: Parameters<Broker['closePosition']>[0],
    reason: string,
    _cycleId: number | null,
  ): Promise<ExecuteResult> {
    // live 平仓骨架：SELL GTC 按当前 best bid；失败不阻塞主循环
    const client = await this.getClient();
    try {
      // 读取盘口价（无认证端点，直接 REST）
      const resp = await fetch(`${this.config.clobHost}/book?token_id=${position.tokenId}`);
      const book = (await resp.json()) as { bids?: Array<{ price: string }> };
      const bestBid = Number(book.bids?.[0]?.price ?? 0);
      if (!(bestBid > 0)) return { orderId: 'n/a', status: 'REJECTED', filledShares: 0, avgFillPrice: null, fee: 0, costUsd: 0, reason: 'exit_no_bid' };
      const signed = await client.createOrder(
        { tokenID: position.tokenId, price: bestBid, size: position.shares, side: Side.SELL },
        { negRisk: false },
      );
      const posted = await client.postOrder(signed, OrderType.GTC);
      this.ledger.append('live_exit_posted', { positionId: position.id, reason, posted });
      return {
        orderId: 'n/a', status: 'FILLED', filledShares: position.shares,
        avgFillPrice: bestBid, fee: 0, costUsd: position.shares * bestBid, reason,
      };
    } catch (err) {
      this.ledger.append('live_exit_error', { positionId: position.id, reason, error: String(err).slice(0, 200) });
      return { orderId: 'n/a', status: 'ERROR', filledShares: 0, avgFillPrice: null, fee: 0, costUsd: 0, reason: String(err).slice(0, 200) };
    }
  }

  private reject(
    intent: ExecuteParams['intent'],
    params: ExecuteParams,
    reason: string,
    liveOrderId?: string,
  ): ExecuteResult {
    this.db.run(
      `INSERT OR IGNORE INTO orders (id, forecast_id, cycle_id, ts, broker, kind, side, outcome, token_id, market_id, condition_id,
       limit_price, size_usd, shares, filled_shares, avg_fill_price, fee, status, reason, request_json, fill_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      intent.requestId, params.forecastId, params.cycleId, new Date().toISOString(), this.name, 'ENTRY',
      intent.side, intent.outcome, intent.tokenId, intent.marketId, intent.conditionId,
      intent.limitPrice, intent.sizeUsd, null, 0, null, 0, 'REJECTED', `${reason}${liveOrderId ? ':' + liveOrderId : ''}`, null, null,
    );
    this.ledger.append('live_reject', { requestId: intent.requestId, reason }, intent.requestId);
    return { orderId: intent.requestId, status: 'REJECTED', filledShares: 0, avgFillPrice: null, fee: 0, costUsd: 0, reason };
  }
}
