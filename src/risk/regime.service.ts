import { Injectable } from '@nestjs/common';
import { PortfolioService } from '../portfolio/portfolio.service';

export type Regime = 'calm' | 'normal' | 'elevated' | 'extreme';

export const REGIME_MULTIPLIER: Record<Regime, number> = {
  calm: 1.2,
  normal: 1.0,
  elevated: 0.5,
  extreme: 0.25,
};

/**
 * 波动率 regime（研究文档 4 档仓位乘数）。
 * 代理指标：当前组合回撤（确定性、可复现）：
 *   <2% calm / <5% normal / <12% elevated / ≥12% extreme（extreme 时引擎直接停机）
 */
@Injectable()
export class RegimeService {
  constructor(private portfolio: PortfolioService) {}

  compute(): { regime: Regime; drawdown: number } {
    const dd = this.portfolio.drawdown();
    let regime: Regime;
    if (dd < 0.02) regime = 'calm';
    else if (dd < 0.05) regime = 'normal';
    else if (dd < 0.12) regime = 'elevated';
    else regime = 'extreme';
    return { regime, drawdown: dd };
  }
}
