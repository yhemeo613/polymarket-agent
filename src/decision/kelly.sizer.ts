import { Decimal, dec, D0, fullKellyFraction } from '../common/decimal.util';

export interface KellyInput {
  pFinal: number | Decimal;
  price: number | Decimal;
  bankrollUsd: number;
  /** Kelly 分数（如 0.25 = quarter Kelly） */
  fraction: number;
  /** 单笔硬帽（占 bankroll 比例） */
  maxSinglePct: number;
}

export interface KellyResult {
  fullKelly: Decimal;
  sizedKelly: Decimal;
  sizeUsd: Decimal;
}

/**
 * Kelly 仓位（确定性）：
 * 二值合约买价 p、真实概率 p̂：f* = (p̂−p)/(1−p)；
 * 实际仓位 = f* × fraction，再按单笔硬帽截断。edge≤0 时返回 0。
 */
export function kellySize(input: KellyInput): KellyResult {
  const p = dec(input.pFinal);
  const price = dec(input.price);
  if (price.lte(0) || price.gte(1) || p.lte(price)) {
    return { fullKelly: D0, sizedKelly: D0, sizeUsd: D0 };
  }
  const fullKelly = fullKellyFraction(p, price);
  const sizedKelly = fullKelly.mul(dec(input.fraction));
  const cap = dec(input.maxSinglePct);
  const f = Decimal.min(sizedKelly, cap);
  const sizeUsd = f.mul(dec(input.bankrollUsd));
  return { fullKelly, sizedKelly, sizeUsd };
}
