import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { RulesService, RuleDef } from '../decision/rules.service';
import { dec } from '../common/decimal.util';
import { nowIso, sha256 } from '../common/hash.util';
import type { ShadowRuleRow } from '../db/schema';

const PROMOTE_T = -2.807; // 99.5% 单侧（研究文档：事件聚类 99.5% 区间全 <0 才晋升）
const RETIRE_T = 2.807;
const MIN_N = 20; // ≥20 个独立事件才裁决
const MAX_ACTIVE_RULES = 6;

interface Welford { n: number; mean: number; m2: number }

/**
 * 影子规则晋升制（phil 机制）：
 * 新规则先 SHADOW —— 结算时对每个样本计算配对差值 diff = (p_rule−y)² − (p_cal−y)²，
 * Welford 增量累计；n≥20 且配对 t < −2.807 → ACTIVE；t > +2.807 → RETIRED；
 * 在册（ACTIVE）规则 ≤ 6 条。规则本身是纯函数，可离线重放。
 */
@Injectable()
export class ShadowPromotionService {
  private readonly logger = new Logger(ShadowPromotionService.name);

  constructor(private db: DbService, private rules: RulesService) {}

  /** 结算守护回调：用该 condition 的已结算样本更新所有未退役规则 */
  updateForCondition(conditionId: string, result: string): void {
    const y = result === 'YES' ? 1 : 0;
    const rows = this.db.all<{ id: number; pCal: number | null; category: string | null }>(
      'SELECT id, p_cal, category FROM forecasts WHERE condition_id = ? AND status = ? AND p_cal IS NOT NULL',
      conditionId, 'SETTLED',
    );
    if (!rows.length) return;
    const category = rows[0].category ?? '';
    const ruleRows = this.db.all<ShadowRuleRow>(
      "SELECT * FROM shadow_rules WHERE status IN ('SHADOW','ACTIVE')",
    );
    for (const rule of ruleRows) {
      const def = RulesService.parseDef(rule.defJson);
      if (!def) continue;
      for (const row of rows) {
        const pCal = dec(row.pCal as number);
        const out = RulesService.applyDef(def, pCal, { category });
        if (out.exclude) continue; // 排除规则不计配对差值
        const pRule = out.p;
        const diff = pRule.minus(y).pow(2).minus(pCal.minus(y).pow(2)).toNumber();
        this.applyWelford(rule, diff);
      }
      // 重读最新统计后再裁决（避免陈旧快照）
      const fresh = this.db.get<ShadowRuleRow>('SELECT * FROM shadow_rules WHERE id = ?', rule.id);
      if (fresh) this.evaluateRule(fresh);
    }
  }

  private applyWelford(rule: ShadowRuleRow, x: number): Welford {
    const n = rule.n + 1;
    const delta = x - rule.meanDiff;
    const mean = rule.meanDiff + delta / n;
    const m2 = rule.m2 + delta * (x - mean);
    // 零方差（每样本 diff 恒定）时以大数表示极端显著（SQLite REAL 不能存 Infinity）
    const T_INF_POS = 1e9;
    const tStat =
      n >= 2 ? (m2 > 0 ? mean / Math.sqrt(m2 / (n - 1) / n) : mean > 0 ? T_INF_POS : -T_INF_POS) : null;
    this.db.run(
      'UPDATE shadow_rules SET n = ?, mean_diff = ?, m2 = ?, t_stat = ?, updated_at = ? WHERE id = ?',
      n, mean, m2, tStat, nowIso(), rule.id,
    );
    return { n, mean, m2 };
  }

  private evaluateRule(rule: ShadowRuleRow): void {
    if (rule.n < MIN_N) return;
    const t = rule.tStat;
    if (t == null) return;
    if (t < PROMOTE_T) {
      const activeCount = this.rules.countByStatus('ACTIVE');
      if (activeCount >= MAX_ACTIVE_RULES) {
        this.rules.setStatus(rule.id, 'RETIRED', `t=${t.toFixed(3)} 通过但在册规则已满(${activeCount})`);
        this.logger.log(`影子规则 ${rule.name} 统计达标但在册已满 → RETIRED`);
      } else {
        this.rules.setStatus(rule.id, 'ACTIVE', `t=${t.toFixed(3)}, n=${rule.n}, meanDiff=${rule.meanDiff.toFixed(5)}`);
        this.logger.log(`影子规则晋升 ACTIVE: ${rule.name} (t=${t.toFixed(3)}, n=${rule.n})`);
      }
    } else if (t > RETIRE_T) {
      this.rules.setStatus(rule.id, 'RETIRED', `t=${t.toFixed(3)} 显著劣于基线 → 强制退役`);
      this.logger.log(`影子规则强制退役: ${rule.name} (t=${t.toFixed(3)})`);
    }
  }

  /** 规则审计指纹清单 */
  fingerprints(): Array<{ name: string; status: string; fingerprint: string; n: number; tStat: number | null }> {
    return this.db.all<ShadowRuleRow>('SELECT * FROM shadow_rules').map((r) => ({
      name: r.name,
      status: r.status,
      fingerprint: sha256(`${r.name}|${r.defJson}|${r.status}`),
      n: r.n,
      tStat: r.tStat,
    }));
  }
}
