import { makeStack } from './helpers';
import { OrderBookService } from '../src/polymarket/orderbook.service';
import { ClobMarketApi } from '../src/polymarket/clob.market.api';
import { WsBookSubscriber } from '../src/polymarket/ws.book.subscriber';
import { PortfolioService } from '../src/portfolio/portfolio.service';
import { LedgerService } from '../src/audit/ledger.service';
import { PaperBroker } from '../src/execution/paper.broker';
import type { TradeIntent } from '../src/decision/decision.service';
import type { Book } from '../src/polymarket/gamma.types';

function syntheticBook(tokenId: string): Book {
  return {
    tokenId,
    bids: [
      { price: 0.47, size: 50 },
      { price: 0.45, size: 100 },
    ],
    asks: [
      { price: 0.50, size: 40 },
      { price: 0.52, size: 60 },
      { price: 0.55, size: 100 },
    ],
    tickSize: 0.01,
    minOrderSize: 5,
    negRisk: false,
    fetchedAt: new Date().toISOString(),
    source: 'rest',
  };
}

function makeIntent(over: Partial<TradeIntent> = {}): TradeIntent {
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    marketId: 'm1',
    conditionId: 'cond1',
    eventId: 'e1',
    question: 'test market',
    category: 'Politics',
    tokenId: 'tok1',
    side: 'BUY',
    outcome: 'YES',
    pFinal: 0.6,
    pCal: 0.6,
    edge: 0.05,
    sizeUsd: 25,
    limitPrice: 0.5,
    takerRate: 0.04,
    slippagePct: 0.01,
    appliedRules: [],
    ...over,
  };
}

function buildBroker(dbPath = ':memory:') {
  const { config, db } = makeStack({ DB_PATH: dbPath });
  const clobApi = new ClobMarketApi(config);
  const ws = new WsBookSubscriber(config);
  const orderBook = new OrderBookService(clobApi, ws, config);
  const portfolio = new PortfolioService(db);
  const ledger = new LedgerService(db);
  const broker = new PaperBroker(config, orderBook, portfolio, ledger, db);
  return { config, db, orderBook, portfolio, ledger, broker };
}

describe('深度走单不变量（M07）', () => {
  it('BUY $25 走 ask 深度：预算限制下 40×0.50 + (5/0.52)×0.52 → 49.6154 份', () => {
    const { orderBook } = buildBroker();
    const fill = orderBook.depthFill('BUY', syntheticBook('t'), { usd: 25 });
    expect(fill.filledShares).toBeCloseTo(49.615384, 4);
    expect(fill.costUsd).toBeCloseTo(25.0, 6);
    expect(fill.avgPrice).toBeCloseTo(25 / 49.615384, 6);
    expect(fill.exhausted).toBe(false);
  });

  it('深度不足 → 部分成交标记 exhausted', () => {
    const { orderBook } = buildBroker();
    const fill = orderBook.depthFill('BUY', syntheticBook('t'), { usd: 1000 });
    // 全部 ask 深度: 40×0.5+60×0.52+100×0.55 = 20+31.2+55 = 106.2
    expect(fill.filledShares).toBeCloseTo(200, 6);
    expect(fill.costUsd).toBeCloseTo(106.2, 6);
    expect(fill.exhausted).toBe(true);
  });

  it('SELL 走 bid 深度（best bid 优先）', () => {
    const { orderBook } = buildBroker();
    const fill = orderBook.depthFill('SELL', syntheticBook('t'), { shares: 60 });
    expect(fill.filledShares).toBeCloseTo(60, 6);
    expect(fill.avgPrice).toBeCloseTo((0.47 * 50 + 0.45 * 10) / 60, 6);
  });

  it('占位书判定：空盘口 / 价差≥0.9', () => {
    const { orderBook } = buildBroker();
    expect(orderBook.isPlaceholder(null)).toBe(true);
    expect(orderBook.isPlaceholder({ ...syntheticBook('t'), asks: [], bids: [] } as Book)).toBe(true);
    expect(orderBook.isPlaceholder({ ...syntheticBook('t'), bids: [{ price: 0.02, size: 10 }], asks: [{ price: 0.98, size: 10 }] })).toBe(true);
    expect(orderBook.isPlaceholder(syntheticBook('t'))).toBe(false);
  });
});

describe('PaperBroker 幂等与记账（M13）', () => {
  it('requestId 重复执行 → 幂等返回不重复记账', async () => {
    const built = buildBroker();
    const { broker, db } = built;
    const book = syntheticBook('tok1');
    jest.spyOn(built.orderBook, 'getBook').mockResolvedValue(book);

    const intent = makeIntent();
    const r1 = await broker.execute({ intent, forecastId: 1, cycleId: 1 });
    expect(r1.status === 'FILLED' || r1.status === 'PARTIAL').toBe(true);
    const r2 = await broker.execute({ intent, forecastId: 1, cycleId: 1 });
    expect(r2.orderId).toBe(r1.orderId);
    expect(r2.reason).toBe('idempotent_replay');
    const orderRows = db.all<{ id: string }>('SELECT id FROM orders WHERE id = ?', intent.requestId);
    expect(orderRows.length).toBe(1);
  });

  it('成交后现金扣减、持仓建立、账本入链', async () => {
    const built = buildBroker();
    const { broker, db, portfolio, ledger } = built;
    const book = syntheticBook('tok2');
    jest.spyOn(built.orderBook, 'getBook').mockResolvedValue(book);
    const intent = makeIntent({ requestId: 'req-ok', tokenId: 'tok2', sizeUsd: 20 });
    const r = await broker.execute({ intent, forecastId: 1, cycleId: 1 });
    expect(['FILLED', 'PARTIAL']).toContain(r.status);
    const wallet = portfolio.getWallet();
    expect(wallet.cashUsd).toBeLessThan(built.config.bankrollUsd);
    const positions = portfolio.openPositions();
    expect(positions.length).toBe(1);
    expect(positions[0].shares).toBeCloseTo(r.filledShares, 6);
    expect(ledger.verify().ok).toBe(true);
    void db;
  });
});
