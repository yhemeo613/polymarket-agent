import { takerFeeRate, takerFeeUsd } from '../src/polymarket/fees';
import { dec } from '../src/common/decimal.util';

describe('费率不变量（M08）', () => {
  it('fee = C·rate·p·(1−p)：C=100, p=0.5, rate=4% → 1.0 USD', () => {
    const fee = takerFeeUsd(dec(100), dec(0.5), 0.04);
    expect(fee.toNumber()).toBeCloseTo(1.0, 6);
  });

  it('p→0/1 时费用趋零（公式固有性质）', () => {
    expect(takerFeeUsd(dec(100), dec(0.001), 0.07).toNumber()).toBeCloseTo(0.00699, 4);
    expect(takerFeeUsd(dec(100), dec(0.999), 0.07).toNumber()).toBeCloseTo(0.00699, 4);
  });

  it('品类映射：crypto 7% / sports 5% / politics 4% / geopolitics 0%', () => {
    expect(takerFeeRate('Crypto', 0.07)).toBe(0.07);
    expect(takerFeeRate('Sports%', 0.07)).toBe(0.05);
    expect(takerFeeRate('Politics', 0.07)).toBe(0.04);
    expect(takerFeeRate('Geopolitics', 0.07)).toBe(0.0);
  });

  it('未知/缺失品类 → 保守兜底（默认 7%）', () => {
    expect(takerFeeRate(null, 0.07)).toBe(0.07);
    expect(takerFeeRate('some-new-category', 0.07)).toBe(0.07);
    expect(takerFeeRate('', 0.05)).toBe(0.05);
  });
});
