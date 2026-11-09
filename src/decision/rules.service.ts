import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import type { ShadowRuleRow } from '../db/schema';
import { nowIso, sha256 } from '../common/hash.util';
import { dec, clamp01, D1, D0 } from '../common/decimal.util';
import { Decimal } from '../common/decimal.util';
import type { MarketView } from '../polymarket/gamma.types';

export type RuleDef =
  | { type: 'shift_prob'; delta: number }
  | { type: 'cap_extremes'; lo: number; hi: number }
  | { type: 'exclude_category'; category: string };

export interface RulesOutcome {
  pFinal: number;
  applied: Array<{ name: string; before: number; after: number }>;
  excluded: boolean;
  excludeReason?: string;
}

/**
 * 概率规则引擎。
 * - ACTIVE 规则实际修正 p_final
 * - SHADOW 规则只记录不生效（由 ShadowPromotion 用配对统计决定晋升/退役）
 * 规则是纯函数（def_json 定义），同一输入永远同一输出 —— 可在结算时离线重放评估。
 */
@Injectable()
export class RulesService {
  constructor(private db: DbService) {}

  static parseDef(defJson: string): RuleDef | null {
    try {
      const d = JSON.parse(defJson) as RuleDef;
      if (d.type === 'shift_prob' && Number.isFinite(d.delta)) return d;
      if (d.type === 'cap_extremes' && d.lo < d.hi) return d;
      if (d.type === 'exclude_category' && !!d.category) return d;
      return null;
    } catch {
      return null;
    }
  }

  /** 规则纯函数：给定 def + 当前概率 + 市场元数据 → 新概率（或排除） */
  static applyDef(def: RuleDef, p: Decimal, market: Pick<MarketView, 'category'>): { p: Decimal; exclude: boolean } {
    switch (def.type) {
      case 'shift_prob':
        return { p: clamp01(p.plus(dec(def.delta))), exclude: false };
      case 'cap_extremes':
        return { p: Decimal.min(dec(def.hi), Decimal.max(dec(def.lo), p)), exclude: false };
      case 'exclude_category': {
        const cat = (market.category ?? '').toLowerCase();
        const exclude = !!cat && cat.includes(def.category.toLowerCase());
        return { p, exclude };
      }
    }
  }

  listByStatus(status: ShadowRuleRow['status']): ShadowRuleRow[] {
    return this.db.all<ShadowRuleRow>('SELECT * FROM shadow_rules WHERE status = ? ORDER BY id', status);
  }

  countByStatus(status: ShadowRuleRow['status']): number {
    const row = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM shadow_rules WHERE status = ?', status);
    return row?.c ?? 0;
  }

  /** 对 p_cal 依次应用在册（ACTIVE）规则 → p_final */
  apply(pCal: number, market: Pick<MarketView, 'category'>): RulesOutcome {
    let p = dec(pCal);
    const applied: RulesOutcome['applied'] = [];
    let excluded = false;
    let excludeReason: string | undefined;
    for (const rule of this.listByStatus('ACTIVE')) {
      const def = RulesService.parseDef(rule.defJson);
      if (!def) continue;
      const out = RulesService.applyDef(def, p, market);
      if (out.exclude) {
        excluded = true;
        excludeReason = `rule:${rule.name}`;
        continue;
      }
      applied.push({ name: rule.name, before: p.toNumber(), after: out.p.toNumber() });
      p = out.p;
    }
    return { pFinal: clamp01(p).toNumber(), applied, excluded, excludeReason };
  }

  /** 创建影子规则（ops API / 人工通道；LLM 无权直接创建） */
  createShadow(name: string, def: RuleDef): ShadowRuleRow {
    const defJson = JSON.stringify(def);
    if (!RulesService.parseDef(defJson)) throw new Error(`非法规则定义: ${defJson}`);
    this.db.run(
      'INSERT INTO shadow_rules (name, def_json, status, created_at) VALUES (?, ?, ?, ?)',
      name, defJson, 'SHADOW', nowIso(),
    );
    const row = this.db.get<ShadowRuleRow>('SELECT * FROM shadow_rules WHERE name = ?', name);
    if (!row) throw new Error('规则创建失败');
    return row;
  }

  setStatus(id: number, status: ShadowRuleRow['status'], verdict?: string) {
    this.db.run(
      'UPDATE shadow_rules SET status = ?, verdict = ?, updated_at = ? WHERE id = ?',
      status, verdict ?? null, nowIso(), id,
    );
  }

  /** 规则指纹（审计用） */
  fingerprint(rule: ShadowRuleRow): string {
    return sha256(`${rule.name}|${rule.defJson}|${rule.status}`);
  }

  static readonly ZERO = D0;
  static readonly ONE = D1;
}
