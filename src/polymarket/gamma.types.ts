/** Gamma API 原始市场字段（部分字段是 JSON 字符串，需防御解析） */
export interface GammaMarketRaw {
  id: string | number;
  question: string;
  conditionId?: string;
  slug?: string;
  endDate?: string;
  liquidity?: string | number;
  volume24hr?: string | number;
  volume?: string | number;
  category?: string | null;
  outcomes?: string; // '["Yes","No"]'
  outcomePrices?: string; // '["0.5","0.5"]'
  clobTokenIds?: string; // '["123...","456..."]'
  negRisk?: boolean;
  restricted?: boolean;
  enableOrderBook?: boolean;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  events?: Array<{ id?: string | number; title?: string; slug?: string }>;
}

/** 归一化后的市场视图（Agent 内部统一使用） */
export interface MarketView {
  id: string;
  conditionId: string;
  eventId: string | null;
  question: string;
  category: string | null;
  endDate: string | null;
  liquidity: number;
  volume24h: number;
  negRisk: boolean;
  outcomes: string[];
  prices: number[];
  yesTokenId: string | null;
  noTokenId: string | null;
  /** YES 侧中间价（来自 outcomePrices） */
  mid: number | null;
  active: boolean;
  closed: boolean;
}

/** CLOB 订单簿单档 */
export interface BookLevel {
  price: number;
  size: number;
}

/** CLOB /book 快照（规范化排序后） */
export interface Book {
  tokenId: string;
  /** best bid 在前（价格降序） */
  bids: BookLevel[];
  /** best ask 在前（价格升序） */
  asks: BookLevel[];
  tickSize: number | null;
  minOrderSize: number | null;
  negRisk: boolean | null;
  fetchedAt: string;
  source: 'rest' | 'ws';
}

/** 深度走单结果（确定性，无随机） */
export interface DepthFill {
  requestedUsd: number | null;
  requestedShares: number | null;
  filledShares: number;
  costUsd: number; // BUY 为花费；SELL 为收入
  avgPrice: number | null;
  limitPrice: number | null;
  exhausted: boolean; // 盘口深度不足
}
