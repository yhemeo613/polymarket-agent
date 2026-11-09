import type { TradeIntent } from '../decision/decision.service';
import type { PositionRow } from '../db/schema';

export interface ExecuteParams {
  intent: TradeIntent;
  forecastId: number | null;
  cycleId: number | null;
}

export interface ExecuteResult {
  orderId: string;
  status: 'FILLED' | 'PARTIAL' | 'REJECTED' | 'ERROR';
  filledShares: number;
  avgFillPrice: number | null;
  fee: number;
  costUsd: number;
  reason?: string;
  positionId?: number;
  realizedPnl?: number;
}

/**
 * 执行器接口：paper 与 live 同一签名，上游（cycle）无感知切换。
 * 幂等约定：同一 intent.requestId 重复调用必须返回既有结果而不重复下单。
 */
export interface Broker {
  readonly name: 'PAPER' | 'LIVE';
  execute(params: ExecuteParams): Promise<ExecuteResult>;
  closePosition(
    position: PositionRow,
    reason: string,
    cycleId: number | null,
  ): Promise<ExecuteResult>;
}
