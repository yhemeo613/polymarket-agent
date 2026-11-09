import { makeStack } from './helpers';
import { ScoreService } from '../src/evolution/score.service';
import { CalibrationService } from '../src/decision/calibration.service';

describe('评分与校准（M15/M11）', () => {
  it('brier_delta 配对统计与 ROI 聚合正确', () => {
    const { db } = makeStack();
    const score = new ScoreService(db);
    // 样本1: p_final=0.8, mid=0.7, y=0 → agent brier=0.64, market=0.49, delta=+0.15
    // 样本2: p_final=0.3, mid=0.4, y=1 → agent brier=0.49, market=0.36, delta=+0.13
    db.run(
      "INSERT INTO forecasts (ts, market_id, condition_id, question, outcome, p_final, market_mid_at_call, decision, status, result, y, brier_agent, brier_market, brier_delta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      't', 'm1', 'c1', 'q1', 'YES', 0.8, 0.7, 'SKIP', 'SETTLED', 'NO', 0, 0.64, 0.49, 0.15,
    );
    db.run(
      "INSERT INTO forecasts (ts, market_id, condition_id, question, outcome, p_final, market_mid_at_call, decision, status, result, y, brier_agent, brier_market, brier_delta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      't', 'm2', 'c2', 'q2', 'YES', 0.3, 0.4, 'SKIP', 'SETTLED', 'YES', 1, 0.49, 0.36, 0.13,
    );
    const s = score.summary();
    expect(s.settled).toBe(2);
    expect(s.brierDelta).toBeCloseTo(0.14, 8);
    expect(s.brierDeltaWins).toBe(0);
  });

  it('校准层：样本 <50 时恒等直通（不伪造 alpha）', () => {
    const { db } = makeStack();
    const cal = new CalibrationService(db);
    const fit = cal.fit();
    expect(fit.n).toBe(0);
    expect(fit.a).toBe(1);
    expect(fit.b).toBe(0);
    expect(cal.calibrate(0.7)).toBeCloseTo(0.7, 10);
  });

  it('校准层：样本充足时拟合方向正确（系统性高估被压缩）', () => {
    const { db } = makeStack();
    // 构造 60 个样本：p_raw 恒 0.8，实际 y 恒 0 → 校准应将 0.8 压低
    for (let i = 0; i < 60; i++) {
      db.run(
        "INSERT INTO forecasts (ts, market_id, condition_id, question, outcome, p_raw, decision, status, y) VALUES (?,?,?,?,?,?,?,?,?)",
        't', `m${i}`, `c${i}`, 'q', 'YES', 0.8, 'SKIP', 'SETTLED', 0,
      );
    }
    const cal = new CalibrationService(db);
    cal.fit();
    const calibrated = cal.calibrate(0.8);
    expect(calibrated).toBeLessThan(0.8);
  });
});
