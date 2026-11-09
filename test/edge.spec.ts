import { computeEdge } from '../src/decision/edge.calculator';

describe('edge 计算不变量（M11）', () => {
  it('p̂=0.6, ask=0.5, rate=4%, slip=0 → fee/USD = 0.04×0.5 = 0.02，edge = 0.08', () => {
    const out = computeEdge({ pFinal: 0.6, price: 0.5, takerRate: 0.04, slippagePct: 0 });
    // 每 USD：毛 0.10 − 费 0.02 = 0.08
    expect(out.edge.toNumber()).toBeCloseTo(0.08, 8);
    expect(out.feePct.toNumber()).toBeCloseTo(0.02, 8);
  });

  it('盈亏平衡概率 = price + fee + slip', () => {
    const out = computeEdge({ pFinal: 0.9, price: 0.5, takerRate: 0.07, slippagePct: 0.01 });
    const be = out.breakEvenProb.toNumber();
    expect(out.edge.toNumber()).toBeCloseTo(0.9 - be, 8);
    expect(be).toBeCloseTo(0.5 + 0.07 * 0.5 + 0.005, 8);
  });

  it('p̂ 低于盈亏平衡 → edge 为负（不下单）', () => {
    const out = computeEdge({ pFinal: 0.5, price: 0.6, takerRate: 0.04, slippagePct: 0.005 });
    expect(out.edge.toNumber()).toBeLessThan(0);
  });

  it('极端价格（0 或 1）→ edge=0 且不产生 NaN', () => {
    expect(computeEdge({ pFinal: 0.7, price: 0, takerRate: 0.04, slippagePct: 0 }).edge.toNumber()).toBe(0);
    expect(computeEdge({ pFinal: 0.7, price: 1, takerRate: 0.04, slippagePct: 0 }).edge.toNumber()).toBe(0);
    expect(Number.isFinite(computeEdge({ pFinal: 0.5, price: 0.999, takerRate: 0.07, slippagePct: 0.05 }).edge.toNumber())).toBe(true);
  });
});
