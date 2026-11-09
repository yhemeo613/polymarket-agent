import { Decimal, D0 } from '../common/decimal.util';

/**
 * Polymarket 费率表（研究结论，2026 现状）：
 * - maker 恒为 0（且 15~25% 返佣）
 * - taker = C × rate × p × (1−p)，按品类：
 *   crypto 7% / sports 5% / politics·finance·tech·mentions 4% / geopolitics 0
 * - 未知/缺失品类 → 保守兜底（默认 7%），宁可高估成本
 */
const TAKER_BY_CATEGORY: Array<[string[], number]> = [
  [['geopolitics'], 0.0], // 必须在 politics 之前（includes 匹配顺序敏感）
  [['crypto'], 0.07],
  [['sports'], 0.05],
  [['politics', 'finance', 'tech', 'mentions'], 0.04],
];

export function normalizeCategory(category: string | null | undefined): string {
  return (category ?? '').trim().toLowerCase();
}

export function takerFeeRate(
  category: string | null | undefined,
  fallbackRate: number,
): number {
  const c = normalizeCategory(category);
  if (!c) return fallbackRate;
  for (const [keys, rate] of TAKER_BY_CATEGORY) {
    if (keys.some((k) => c.includes(k))) return rate;
  }
  return fallbackRate;
}

/** taker 手续费（USD）：shares × rate × p × (1−p) */
export function takerFeeUsd(
  shares: Decimal | number,
  price: Decimal | number,
  rate: number,
): Decimal {
  const s = new Decimal(shares);
  const p = new Decimal(price);
  if (s.lte(0) || p.lte(0) || p.gte(1)) return D0;
  return s.mul(rate).mul(p).mul(new Decimal(1).minus(p));
}

/** maker 手续费恒为 0 */
export const makerFeeUsd = (): Decimal => D0;
