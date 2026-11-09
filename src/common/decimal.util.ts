import Decimal from 'decimal.js';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

export const D0 = new Decimal(0);
export const D1 = new Decimal(1);

export const dec = (v: Decimal.Value): Decimal => new Decimal(v);

/** sigmoid(logit 仿射校准用) */
export const sigmoid = (x: Decimal): Decimal => {
  // 数值稳定实现：x>=0 → 1/(1+e^-x)；x<0 → e^x/(1+e^x)
  if (x.gte(0)) return D1.div(D1.plus(x.neg().exp()));
  const ex = x.exp();
  return ex.div(D1.plus(ex));
};

export const logit = (p: Decimal): Decimal => {
  const pc = clamp01(p);
  return pc.div(D1.minus(pc)).ln();
};

export const clamp01 = (p: Decimal): Decimal => Decimal.min(D1, Decimal.max(D0, p));

/**
 * quarter-Kelly：二值合约买入价 p、真实概率 p̂ 时 f* = (p̂−p)/(1−p)。
 * 返回未截断的满 Kelly 分数（调用方负责乘 fraction 与硬帽截断）。
 */
export const fullKellyFraction = (pHat: Decimal, price: Decimal): Decimal => {
  const denom = D1.minus(price);
  if (denom.lte(0)) return D0;
  return pHat.minus(price).div(denom);
};
