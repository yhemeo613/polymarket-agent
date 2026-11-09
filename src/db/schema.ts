/**
 * 数据库行类型定义（node:sqlite 无 schema 文件，建表 SQL 在 db.service.ts）。
 * 命名：表名列用 snake_case（SQL），行对象用 camelCase（TS）。
 */

export interface CycleRow {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  mode: 'baseline' | 'research';
  trigger: 'cron' | 'manual' | 'light';
  marketsScanned: number;
  forecasts: number;
  orders: number;
  errors: number;
  summaryJson: string | null;
}

export interface ForecastRow {
  id: number;
  cycleId: number | null;
  ts: string;
  marketId: string;
  conditionId: string;
  eventId: string | null;
  question: string;
  category: string | null;
  endDate: string | null;
  yesTokenId: string | null;
  noTokenId: string | null;
  outcome: 'YES' | 'NO';
  pRaw: number | null;
  pCal: number | null;
  pFinal: number | null;
  confidence: number | null;
  marketMidAtCall: number | null;
  bestAskAtCall: number | null;
  evidenceJson: string | null;
  appliedRulesJson: string | null;
  decision: 'BET' | 'SKIP';
  skipReason: string | null;
  status: 'OPEN' | 'SETTLED';
  result: string | null;
  y: number | null;
  brierAgent: number | null;
  brierMarket: number | null;
  brierDelta: number | null;
  rationale: string | null;
}

export interface OrderRow {
  id: string;
  forecastId: number | null;
  cycleId: number | null;
  ts: string;
  broker: 'PAPER' | 'LIVE';
  kind: 'ENTRY' | 'EXIT';
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  tokenId: string;
  marketId: string | null;
  conditionId: string | null;
  limitPrice: number | null;
  sizeUsd: number | null;
  shares: number | null;
  filledShares: number;
  avgFillPrice: number | null;
  fee: number;
  status: 'FILLED' | 'PARTIAL' | 'REJECTED' | 'ERROR';
  reason: string | null;
  requestJson: string | null;
  fillJson: string | null;
}

export interface PositionRow {
  id: number;
  forecastId: number | null;
  marketId: string;
  conditionId: string;
  eventId: string | null;
  question: string | null;
  category: string | null;
  outcome: 'YES' | 'NO';
  tokenId: string;
  shares: number;
  avgPrice: number;
  costUsd: number;
  status: 'OPEN' | 'CLOSED';
  openedTs: string;
  closedTs: string | null;
  closeReason: string | null;
  realizedPnl: number | null;
}

export interface SettlementRow {
  conditionId: string;
  marketId: string | null;
  question: string | null;
  result: 'YES' | 'NO';
  resolvedAt: string | null;
  source: string;
  joinedTs: string | null;
}

export type RuleStatus = 'SHADOW' | 'ACTIVE' | 'RETIRED';

export interface ShadowRuleRow {
  id: number;
  name: string;
  defJson: string;
  status: RuleStatus;
  n: number;
  meanDiff: number; // mean(rule_brier - cal_brier)，<0 表示规则优于基线
  m2: number; // Welford 方差累计
  tStat: number | null;
  verdict: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface LedgerRow {
  id: number;
  ts: string;
  kind: string;
  ref: string | null;
  payloadJson: string;
  prevHash: string;
  hash: string;
}

export interface WalletRow {
  id: number;
  cashUsd: number;
  peakEquity: number;
  dayAnchorEquity: number;
  dayKey: string;
  updatedAt: string;
}
