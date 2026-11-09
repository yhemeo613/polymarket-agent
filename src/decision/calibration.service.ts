import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { dec, sigmoid, logit, D1, clamp01 } from '../common/decimal.util';
import { Decimal } from '../common/decimal.util';

const MIN_FIT_N = 50; // 样本不足不拟合，恒等直通（诚实校准原则）
const RIDGE_LAMBDA = 1.0; // 向恒等映射 (a=1,b=0) 的正则强度
const ITERATIONS = 25;

/**
 * 校准层：p_final = σ(a·logit(p_raw) + b)。
 * 从 agent 自身已结算预测拟合 (a,b)，带向恒等映射的 L2 正则 ——
 * 市场校准好时自动退化为无 edge，不伪造 alpha（autopredict 原则）。
 * 牛顿法确定性求解，无随机数。
 */
@Injectable()
export class CalibrationService {
  private cache: { n: number; a: Decimal; b: Decimal } | null = null;
  private fittedAtN = -1;

  constructor(private db: DbService) {}

  /** 拉取已结算样本并拟合（带缓存水位） */
  fit(): { n: number; a: number; b: number } {
    const rows = this.db.all<{ pRaw: number; y: number }>(
      'SELECT p_raw, y FROM forecasts WHERE status = ? AND p_raw IS NOT NULL AND y IS NOT NULL',
      'SETTLED',
    );
    const n = rows.length;
    if (n < MIN_FIT_N) {
      this.cache = { n, a: D1, b: new Decimal(0) };
      return { n, a: 1, b: 0 };
    }
    if (this.cache && this.fittedAtN === n && this.cache.n === n) {
      return { n: this.cache.n, a: this.cache.a.toNumber(), b: this.cache.b.toNumber() };
    }

    // 特征 x = logit(p_raw)，标签 t ∈ {-1, +1}
    const xs: Decimal[] = rows.map((r) => logit(dec(r.pRaw)));
    const ts: Decimal[] = rows.map((r) => new Decimal(r.y === 1 ? 1 : -1));

    let a = D1;
    let b = new Decimal(0);
    const lambda = new Decimal(RIDGE_LAMBDA);

    for (let it = 0; it < ITERATIONS; it++) {
      let ga = new Decimal(0); // dL/da
      let gb = new Decimal(0);
      let haa = lambda.mul(2);
      let hab = new Decimal(0);
      let hbb = lambda.mul(2);
      for (let i = 0; i < n; i++) {
        const z = a.mul(xs[i]).plus(b);
        const s = sigmoid(z);
        const err = s.minus(ts[i]);
        ga = ga.plus(err.mul(xs[i]));
        gb = gb.plus(err);
        const w = s.mul(new Decimal(1).minus(s));
        haa = haa.plus(w.mul(xs[i].mul(xs[i])));
        hab = hab.plus(w.mul(xs[i]));
        hbb = hbb.plus(w);
      }
      ga = ga.plus(lambda.mul(a.minus(1)).mul(2));
      gb = gb.plus(lambda.mul(b).mul(2));
      // H = [[haa, hab], [hab, hbb]]（正定），牛顿步 = H⁻¹ g
      const det = haa.mul(hbb).minus(hab.mul(hab));
      if (det.lte(0)) break; // 数值异常，保持当前值
      const stepA = hbb.mul(ga).minus(hab.mul(gb)).div(det);
      const stepB = haa.mul(gb).minus(hab.mul(ga)).div(det);
      a = a.minus(stepA);
      b = b.minus(stepB);
    }

    this.cache = { n, a, b };
    this.fittedAtN = n;
    return { n, a: a.toNumber(), b: b.toNumber() };
  }

  calibrate(pRaw: number): number {
    if (!this.cache) this.fit();
    const a = this.cache?.a ?? D1;
    const b = this.cache?.b ?? new Decimal(0);
    const p = clamp01(dec(pRaw));
    if (p.lte(0) || p.gte(1)) return Math.min(0.99, Math.max(0.01, pRaw));
    return sigmoid(a.mul(logit(p)).plus(b)).toNumber();
  }
}
