import { makeStack } from './helpers';
import { RulesService } from '../src/decision/rules.service';
import { ShadowPromotionService } from '../src/evolution/shadow.promotion.service';

describe('影子规则晋升（M15）', () => {
  it('有利规则（显著优于基线）n≥20 → ACTIVE', () => {
    const { db, config } = makeStack();
    const rules = new RulesService(db);
    const shadow = new ShadowPromotionService(db, rules);
    // 有利规则：把 p 修低 0.05，而样本实际 y=0（规则方向正确 → diff<0）
    const rule = rules.createShadow('good-rule', { type: 'shift_prob', delta: -0.05 });
    void config;

    // 构造 20 个已结算预测：p_cal=0.8, y=0（基线 brier=0.64；规则后 0.75 → brier=0.5625）
    for (let i = 0; i < 20; i++) {
      db.run(
        "INSERT INTO forecasts (ts, market_id, condition_id, question, outcome, p_cal, decision, status, result, y, brier_agent, brier_market, brier_delta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        't', `m${i}`, `c${i}`, `q${i}`, 'YES', 0.8, 'SKIP', 'SETTLED', 'NO', 0, 0.5625, 0.64, -0.0775,
      );
      shadow.updateForCondition(`c${i}`, 'NO');
    }
    const after = rules.listByStatus('ACTIVE');
    expect(after.map((r) => r.name)).toContain('good-rule');
    void rule;
  });

  it('有害规则（显著劣于基线）n≥20 → RETIRED', () => {
    const { db } = makeStack();
    const rules = new RulesService(db);
    const shadow = new ShadowPromotionService(db, rules);
    // 有害规则：把 p 抬高 0.1，而样本 y=0（方向错误 → diff>0）
    rules.createShadow('bad-rule', { type: 'shift_prob', delta: 0.1 });
    for (let i = 0; i < 30; i++) {
      db.run(
        "INSERT INTO forecasts (ts, market_id, condition_id, question, outcome, p_cal, decision, status, result, y) VALUES (?,?,?,?,?,?,?,?,?,?)",
        't', `m${i}`, `d${i}`, `q${i}`, 'YES', 0.3, 'SKIP', 'SETTLED', 'NO', 0,
      );
      shadow.updateForCondition(`d${i}`, 'NO');
    }
    expect(rules.listByStatus('RETIRED').map((r) => r.name)).toContain('bad-rule');
    expect(rules.listByStatus('ACTIVE').map((r) => r.name)).not.toContain('bad-rule');
  });

  it('exclude_category 规则命中品类时标记排除', () => {
    const { db } = makeStack();
    const rules = new RulesService(db);
    rules.createShadow('no-crypto', { type: 'exclude_category', category: 'crypto' });
    rules.setStatus(rules.listByStatus('SHADOW')[0].id, 'ACTIVE');
    const out = rules.apply(0.5, { category: 'Crypto Prices' });
    expect(out.excluded).toBe(true);
    const outOk = rules.apply(0.5, { category: 'Politics' });
    expect(outOk.excluded).toBe(false);
    expect(outOk.pFinal).toBe(0.5);
  });
});
