import { makeStack } from './helpers';
import { KillSwitchService } from '../src/risk/kill-switch.service';
import { RegimeService } from '../src/risk/regime.service';
import { PortfolioService } from '../src/portfolio/portfolio.service';
import { LedgerService } from '../src/audit/ledger.service';
import { RiskEngine } from '../src/risk/risk.engine';
import type { TradeIntent } from '../src/decision/decision.service';
import * as fs from 'node:fs';

function makeIntent(sizeUsd: number, over: Partial<TradeIntent> = {}): TradeIntent {
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    marketId: 'm1',
    conditionId: 'cond1',
    eventId: 'e1',
    question: 'q',
    category: 'Politics',
    tokenId: 'tok1',
    side: 'BUY',
    outcome: 'YES',
    pFinal: 0.6,
    pCal: 0.6,
    edge: 0.05,
    sizeUsd,
    limitPrice: 0.5,
    takerRate: 0.04,
    slippagePct: 0.01,
    appliedRules: [],
    ...over,
  };
}

describe('风控引擎闸门（M12）', () => {
  afterEach(() => {
    try { fs.rmSync('./data/test-kill.switch', { force: true }); } catch { /* 忽略 */ }
  });

  function buildEngine(dbOverrides: Record<string, string> = {}) {
    const { config, db } = makeStack(dbOverrides);
    const killSwitch = new KillSwitchService(config);
    const portfolio = new PortfolioService(db);
    const regime = new RegimeService(portfolio);
    const ledger = new LedgerService(db);
    const engine = new RiskEngine(config, killSwitch, regime, portfolio, ledger);
    return { config, db, engine, killSwitch, portfolio };
  }

  it('正常路径：小仓位获批，且裁决入 ledger', async () => {
    const { engine } = buildEngine();
    const v = await engine.validate(makeIntent(5));
    expect(v.approved).toBe(true);
    expect(v.rejections).toHaveLength(0);
  });

  it('kill switch 哨兵文件激活 → 拒绝', async () => {
    const { engine, killSwitch } = buildEngine();
    killSwitch.engage('test');
    const v = await engine.validate(makeIntent(5));
    expect(v.approved).toBe(false);
    expect(v.rejections.some((r) => r.startsWith('kill_switch'))).toBe(true);
  });

  it('超单笔帽 → clamp 而非拒绝', async () => {
    const { engine, config } = buildEngine();
    const v = await engine.validate(makeIntent(config.bankrollUsd * 0.5)); // 50% >> 2% 帽
    expect(v.approved).toBe(true);
    expect(v.sizeUsd).toBeCloseTo(config.bankrollUsd * config.maxSinglePct, 6);
    expect(v.clamps.some((c) => c.startsWith('single_cap'))).toBe(true);
  });

  it('总敞口超帽 → 拒绝', async () => {
    const { engine, config, db } = buildEngine({ MAX_TOTAL_PCT: '0.02' });
    // 预置一个持仓吃满敞口
    db.run(
      "INSERT INTO positions (forecast_id, market_id, condition_id, event_id, question, category, outcome, token_id, shares, avg_price, cost_usd, status, opened_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      null, 'm0', 'cond0', 'e0', 'q0', 'Politics', 'YES', 'tok0',
      20, 0.5, config.bankrollUsd * 0.02, 'OPEN', 't',
    );
    const v = await engine.validate(makeIntent(5, { conditionId: 'cond1', eventId: 'e1' }));
    expect(v.approved).toBe(false);
    expect(v.rejections.some((r) => r.startsWith('total_exposure'))).toBe(true);
  });

  it('日亏熔断：日亏超帽 → 拒绝', async () => {
    const { engine, config, db } = buildEngine({ DAILY_LOSS_HALT: '0.02' });
    // 预置已平仓亏损仓位（realized_pnl 负值计入权益 → cash 下降）
    db.run("UPDATE wallet SET cash_usd = ? WHERE id = 1", config.bankrollUsd * 0.97);
    // 锚点是初始 bankroll（ensureWalletRow 写入 day_anchor=bankroll），equity=cash+exposure=97%<98% → 触发
    const v = await engine.validate(makeIntent(1));
    expect(v.approved).toBe(false);
    expect(v.rejections.some((r) => r.startsWith('daily_loss_halt'))).toBe(true);
  });
});
