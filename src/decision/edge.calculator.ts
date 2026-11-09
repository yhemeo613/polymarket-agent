import { Decimal, dec, D0 } from '../common/decimal.util';
import { takerFeeUsd } from '../polymarket/fees';

export interface EdgeInput {
  /** 规则修正后的真实概率估计（YES 侧） */
  pFinal: number | Decimal;
  /** 吃单价（best ask） */
  price: number | Decimal;
  /** taker 费率（0~1） */
  takerRate: number;
  /** 滑点比例估计（0~1，占总价比例） */
  slippagePct: number;
}

export interface EdgeResult {
  /** 每 USD 投入的期望边际（小数） */
  edge: Decimal;
  feePct: Decimal;
  grossEdge: Decimal;
  breakEvenProb: Decimal;
}

/**
 * Edge 计算（确定性，Decimal 精确）—— 钱永远不让 LLM 算。
 * 买入 1 份成本 c = price；成交后期望收益 = p̂·1 + (1−p̂)·0 = p̂。
 * 每 USD 期望毛边际 = p̂ − price；
 * 净边际 = p̂ − price − fee(shares=1/price 折算到每 USD) − price·slippage。
 *
 * fee 公式（Polymarket）：fee = C·rate·p·(1−p)，C 为份额数。
 * 每 USD 对应份额 C = 1/price，故每 USD 费用 = rate·(1−p)。
 */
export function computeEdge(input: EdgeInput): EdgeResult {
  const p = dec(input.pFinal);
  const price = dec(input.price);
  if (price.lte(0) || price.gte(1)) {
    return { edge: D0, feePct: D0, grossEdge: D0, breakEvenProb: D1_like(price) };
  }
  const sharesPerUsd = new Decimal(1).div(price);
  // 每 USD 费用 = (C·rate·p·(1−p)) / C·price = rate·p·(1−p)/price
  const feePerUsd = takerFeeUsd(sharesPerUsd, price, input.takerRate);
  const feePct = feePerUsd; // 已经是每 USD 比例
  const slipPerUsd = price.mul(input.slippagePct);
  const grossEdge = p.minus(price);
  const edge = grossEdge.minus(feePct).minus(slipPerUsd);
  const breakEvenProb = price.plus(feePct).plus(slipPerUsd);
  return { edge, feePct, grossEdge, breakEvenProb };
}

function D1_like(_price: Decimal): Decimal {
  return new Decimal(1);
}
