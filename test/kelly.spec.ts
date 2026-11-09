import { kellySize } from '../src/decision/kelly.sizer';
import { fullKellyFraction, dec } from '../src/common/decimal.util';

describe('Kelly 仓位不变量（M11）', () => {
  it('f* = (p̂−p)/(1−p)：p̂=0.6, p=0.5 → 满Kelly 0.2；quarter → 0.05', () => {
    const fk = fullKellyFraction(dec(0.6), dec(0.5));
    expect(fk.toNumber()).toBeCloseTo(0.2, 8);
    const out = kellySize({ pFinal: 0.6, price: 0.5, bankrollUsd: 500, fraction: 0.25, maxSinglePct: 0.02 });
    expect(out.sizedKelly.toNumber()).toBeCloseTo(0.05, 8);
    expect(out.sizeUsd.toNumber()).toBeCloseTo(10, 8); // 500×0.02 帽截断
  });

  it('单笔硬帽截断生效（sizedKelly 超帽时取帽）', () => {
    const out = kellySize({ pFinal: 0.9, price: 0.5, bankrollUsd: 500, fraction: 1, maxSinglePct: 0.02 });
    expect(out.sizeUsd.toNumber()).toBeCloseTo(10, 6); // 0.8×500=400 → 截到 10
  });

  it('edge≤0 → 仓位为 0', () => {
    const out = kellySize({ pFinal: 0.4, price: 0.5, bankrollUsd: 500, fraction: 0.25, maxSinglePct: 0.02 });
    expect(out.sizeUsd.toNumber()).toBe(0);
  });

  it('极端价格安全', () => {
    const out = kellySize({ pFinal: 0.9, price: 0.999, bankrollUsd: 500, fraction: 0.25, maxSinglePct: 0.02 });
    expect(out.sizeUsd.toNumber()).toBeGreaterThanOrEqual(0);
  });
});
