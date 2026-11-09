import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { GammaApi } from '../polymarket/gamma.api';
import { OrderBookService } from '../polymarket/orderbook.service';
import { MarketFilterService } from '../research/market-filter.service';
import { ForecasterService } from '../research/forecaster.service';
import { ForecastJournal } from '../forecast/forecast.journal';
import { SettleService } from '../forecast/settle.service';
import { DecisionService } from '../decision/decision.service';
import { RiskEngine } from '../risk/risk.engine';
import { KillSwitchService } from '../risk/kill-switch.service';
import { BROKER } from '../execution/execution.module';
import type { Broker } from '../execution/broker.interface';
import { TwinOrderService } from '../execution/twin-order.service';
import { RetroService } from '../evolution/retro.service';
import { StrategyStore } from '../evolution/strategy.store';
import { LedgerService } from '../audit/ledger.service';
import { AlertService } from '../alerting/alert.service';
import { PortfolioService } from '../portfolio/portfolio.service';
import { CycleReporter } from '../cli/cycle.reporter';
import { DbService } from '../db/db.service';
import { Inject } from '@nestjs/common';

interface CycleSummary {
  cycleId: number;
  trigger: string;
  scanned: number;
  hardPassed: number;
  selected: number;
  forecasted: number;
  bets: number;
  rejected: number;
  errors: number;
  settledConditions?: number;
  mode: string;
}

/**
 * 主循环（无人值守核心）：
 * 结算 → 评分复盘 → 扫描 → 筛选 → 逐市场（book→forecast→journal→decision）
 * → 风控 → 执行（paper）→ 孪生单钩子 → 摘要告警。
 * 全局互斥锁防重入；kill switch 激活时整轮跳过。
 * 全过程由 CycleReporter 实时渲染 CLI 过程。
 */
@Injectable()
export class MainCycleService {
  private readonly logger = new Logger(MainCycleService.name);
  private running = false;
  private lastSummary: CycleSummary | null = null;

  constructor(
    private config: AppConfigService,
    private gamma: GammaApi,
    private orderBook: OrderBookService,
    private filter: MarketFilterService,
    private forecaster: ForecasterService,
    private journal: ForecastJournal,
    private settle: SettleService,
    private decision: DecisionService,
    private riskEngine: RiskEngine,
    private killSwitch: KillSwitchService,
    private retro: RetroService,
    private strategy: StrategyStore,
    private twinOrders: TwinOrderService,
    private ledger: LedgerService,
    private alert: AlertService,
    private portfolio: PortfolioService,
    private db: DbService,
    @Inject(BROKER) private broker: Broker,
  ) {}

  get lastCycleSummary(): CycleSummary | null {
    return this.lastSummary;
  }

  /** 主循环是否正在执行（供 Telegram bot / ops API 判断） */
  get busy(): boolean {
    return this.running;
  }

  async runOnce(trigger: 'cron' | 'manual' | 'light' = 'cron'): Promise<CycleSummary | null> {
    if (this.running) {
      this.logger.warn('主循环已在运行，本次触发跳过（防重入锁）');
      return null;
    }
    this.running = true;
    const reporter = new CycleReporter();
    const startedAt = new Date().toISOString();
    const mode = this.config.llmEnabled ? 'research' : 'baseline';
    this.db.run('INSERT INTO cycles (started_at, mode, trigger) VALUES (?,?,?)', startedAt, mode, trigger);
    const cycleRow = this.db.get<{ id: number }>('SELECT id FROM cycles ORDER BY id DESC LIMIT 1');
    const cycleId = cycleRow?.id ?? 0;
    reporter.banner(cycleId, mode, trigger);

    const summary: CycleSummary = {
      cycleId, trigger, scanned: 0, hardPassed: 0, selected: 0,
      forecasted: 0, bets: 0, rejected: 0, errors: 0, mode,
    };
    let skipCount = 0;
    const TOTAL_PHASES = 5;

    try {
      // 0) kill switch 总闸
      if (this.killSwitch.engaged()) {
        reporter.phaseWarn('kill switch 激活 —— 本轮跳过');
        this.logger.warn('kill switch 激活 —— 本轮跳过');
        this.finishCycle(cycleId, summary, 'kill_switch');
        return summary;
      }

      // 1) 结算 + 校准重拟合
      reporter.phase(1, TOTAL_PHASES, '结算检查');
      try {
        const settled = await this.settle.settlePending();
        summary.settledConditions = settled.settledConditions;
        reporter.phaseDone(
          settled.settledConditions > 0
            ? `结算 ${settled.settledConditions} 个市场 · 回填 ${settled.forecastsSettled} 条预测 · 平仓 ${settled.positionsClosed} 个持仓`
            : '无新结算',
        );
        if (settled.settledConditions > 0) {
          this.logger.log(`结算 ${settled.settledConditions} 个市场，回填 ${settled.forecastsSettled} 条预测，平仓 ${settled.positionsClosed} 个持仓`);
        }
      } catch (err) {
        summary.errors++;
        reporter.errorLine(`结算阶段失败: ${String(err).slice(0, 100)}`);
        this.logger.warn(`结算阶段失败: ${String(err).slice(0, 200)}`);
      }

      // 2) 复盘（仅 research 模式；结算有新样本时）
      if (this.config.llmEnabled && (summary.settledConditions ?? 0) > 0) {
        try {
          const retro = await this.retro.runRetro();
          if (retro.ran) reporter.phaseDone(`复盘完成 · playbook 编辑 ${retro.applied} 条${retro.notes ? ` · ${retro.notes.slice(0, 40)}` : ''}`);
        } catch (err) {
          summary.errors++;
          reporter.errorLine(`复盘阶段失败: ${String(err).slice(0, 100)}`);
          this.logger.warn(`复盘阶段失败: ${String(err).slice(0, 200)}`);
        }
      }

      // 3) 扫描 + 筛选
      reporter.phase(2, TOTAL_PHASES, '扫描市场（Gamma）');
      const markets = await this.gamma.fetchTradableMarkets(this.config.scanLimit);
      summary.scanned = markets.length;
      reporter.phaseDone(`${markets.length} 个可交易市场`);

      reporter.phase(3, TOTAL_PHASES, `筛选（硬过滤 → ${this.config.llmEnabled ? 'LLM 语义筛选 → ' : ''}Top-${this.config.screenTopK}）`);
      const filterOut = await this.filter.select(markets);
      summary.hardPassed = filterOut.hardPassed;
      summary.selected = filterOut.selected.length;
      reporter.phaseDone(`硬过滤 ${markets.length} → ${filterOut.hardPassed} · 入选 ${filterOut.selected.length}${this.config.llmEnabled ? ` · LLM筛选${filterOut.llmScreened ? '生效' : '降级'}` : ''}`);
      this.ledger.append('cycle_scan', {
        cycleId, scanned: summary.scanned, hardPassed: summary.hardPassed,
        selected: summary.selected, llmScreened: filterOut.llmScreened,
      });

      // 4) 逐市场：book → forecast → journal → decision → risk → execute
      reporter.phase(4, TOTAL_PHASES, `逐市场研究（${mode} 模式）`);
      reporter.divider();
      const playbookExcerpt = this.strategy.excerpt();
      const tokens = filterOut.selected.map((m) => m.yesTokenId as string);
      await this.orderBook.refreshMany(tokens);

      let marketIdx = 0;
      for (const market of filterOut.selected) {
        marketIdx++;
        if (this.killSwitch.engaged()) { reporter.phaseWarn('kill switch 激活 —— 中断剩余市场'); break; }
        reporter.marketHeader(marketIdx, filterOut.selected.length, market.question);
        try {
          const book = await this.orderBook.getBook(market.yesTokenId as string);
          if (this.orderBook.isPlaceholder(book)) {
            summary.forecasted++;
            skipCount++;
            this.journalForecast(market, 0.5, 'placeholder_book', cycleId, book);
            reporter.marketSkip('占位书（空盘口/价差过大）');
            continue;
          }
          const bestAsk = this.orderBook.bestAsk(book);
          const mid = this.orderBook.midPrice(book);
          reporter.marketStep(`订单簿 ask=${bestAsk?.toFixed(3)} mid=${mid?.toFixed(3)} 价差=${this.orderBook.spread(book)?.toFixed(3)}`);

          const forecast = await this.forecaster.forecast(market, book, playbookExcerpt);
          const evN = forecast.evidence.items.length;
          reporter.marketStep(
            `GLM 预测 p̂=${forecast.pRaw.toFixed(3)}（置信 ${forecast.confidence.toFixed(2)}）· 证据 ${evN} 条${forecast.evidence.degraded && !this.config.tavilyApiKey ? '（闭卷）' : ''}`,
          );

          const decisionOut = await this.decision.evaluate(market, forecast.pRaw, book);
          const forecastId = this.journal.insert({ forecast, decision: decisionOut, cycleId });
          summary.forecasted++;

          if (!decisionOut.intent) {
            skipCount++;
            reporter.marketSkip(decisionOut.skipReason ?? 'unknown');
            continue;
          }
          reporter.marketStep(
            `edge=${decisionOut.intent.edge >= 0 ? '+' : ''}${decisionOut.intent.edge.toFixed(4)} ≥ min ${this.config.minEdge} · Kelly 仓位 $${decisionOut.intent.sizeUsd.toFixed(2)}`,
          );

          // 5) 风控
          const verdict = await this.riskEngine.validate(decisionOut.intent);
          if (!verdict.approved) {
            summary.rejected++;
            this.markSkipByForecastId(forecastId, `risk_rejected:${verdict.rejections.join('|')}`);
            reporter.rejectedLine(verdict.rejections.join('; '));
            continue;
          }
          if (verdict.clamps.length) {
            reporter.marketStep(`风控调整: ${verdict.clamps.join('; ')} → 执行 $${verdict.sizeUsd.toFixed(2)}`);
          }
          // 6) 执行（paper 深度撮合；限流到风控裁定的 size）
          const intent = { ...decisionOut.intent, sizeUsd: verdict.sizeUsd };
          const result = await this.broker.execute({ intent, forecastId, cycleId });
          if (result.status === 'FILLED' || result.status === 'PARTIAL') {
            summary.bets++;
            this.markBetByForecastId(forecastId);
            reporter.betLine(`成交 ${result.filledShares.toFixed(2)} 份 @ ${result.avgFillPrice?.toFixed(4)}（费 $${result.fee.toFixed(4)}，支出 $${result.costUsd.toFixed(2)}）`);
            // 7) 孪生单钩子（P2 阶段，默认关闭）
            if (this.config.twinOrders) {
              void this.twinOrders.mirror(intent, forecastId, cycleId);
            }
          } else {
            summary.rejected++;
            skipCount++;
            this.markSkipByForecastId(forecastId, `exec_${result.status}:${result.reason ?? ''}`);
            reporter.marketSkip(`执行失败 ${result.status}: ${result.reason ?? ''}`);
          }
        } catch (err) {
          summary.errors++;
          reporter.errorLine(String(err));
          this.logger.warn(`市场处理失败 ${market.id}: ${String(err).slice(0, 200)}`);
        }
      }

      // 5) 摘要
      reporter.phase(5, TOTAL_PHASES, '周期汇总');
      const wallet = this.portfolio.getWallet();
      const exposure = this.portfolio.exposure();
      reporter.summary({
        scanned: summary.scanned, hardPassed: summary.hardPassed, selected: summary.selected,
        forecasted: summary.forecasted, bets: summary.bets, rejected: summary.rejected,
        errors: summary.errors, skipCount, settledConditions: summary.settledConditions,
      }, {
        cashUsd: wallet.cashUsd, totalExposure: exposure.total,
        openPositions: exposure.count, drawdown: this.portfolio.drawdown(),
      });

      this.finishCycle(cycleId, summary);
      await this.alert.alert(
        'info',
        `周期 #${cycleId} 完成（${mode}/${trigger}）`,
        `扫描 ${summary.scanned} | 入选 ${summary.selected} | 预测 ${summary.forecasted} | 下注 ${summary.bets} | 拒绝 ${summary.rejected} | 错误 ${summary.errors}`,
      );
      return summary;
    } catch (err) {
      summary.errors++;
      this.logger.error(`主循环异常: ${String(err)}`);
      reporter.errorLine(`主循环异常: ${String(err).slice(0, 200)}`);
      this.finishCycle(cycleId, summary, String(err).slice(0, 300));
      await this.alert.alert('error', `周期 #${cycleId} 异常`, String(err).slice(0, 400));
      return summary;
    } finally {
      this.running = false;
    }
  }

  private journalForecast(
    market: Parameters<ForecasterService['forecast']>[0],
    pRaw: number,
    skipReason: string,
    cycleId: number,
    book: Parameters<OrderBookService['midPrice']>[0],
  ): void {
    // 占位书场景：不生成预测，只落 SKIP 行保留市场足迹
    const mid = this.orderBook.midPrice(book);
    this.db.run(
      `INSERT INTO forecasts (cycle_id, ts, market_id, condition_id, event_id, question, category, end_date,
       yes_token_id, no_token_id, outcome, p_raw, decision, skip_reason, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      cycleId, new Date().toISOString(), market.id, market.conditionId, market.eventId,
      market.question, market.category, market.endDate, market.yesTokenId, market.noTokenId,
      'YES', pRaw, 'SKIP', skipReason, 'OPEN',
    );
    void mid;
  }

  private markSkipByForecastId(forecastId: number, reason: string): void {
    this.db.run('UPDATE forecasts SET decision = ?, skip_reason = ? WHERE id = ?', 'SKIP', reason, forecastId);
  }

  private markBetByForecastId(forecastId: number): void {
    this.db.run('UPDATE forecasts SET decision = ?, skip_reason = NULL WHERE id = ?', 'BET', forecastId);
  }

  private finishCycle(cycleId: number, summary: CycleSummary, note?: string): void {
    this.db.run(
      'UPDATE cycles SET finished_at = ?, markets_scanned = ?, forecasts = ?, orders = ?, errors = ?, summary_json = ? WHERE id = ?',
      new Date().toISOString(), summary.scanned, summary.forecasted, summary.bets, summary.errors,
      JSON.stringify({ ...summary, note }), cycleId,
    );
    this.lastSummary = summary;
    this.ledger.append('cycle_finish', { ...summary, note });
  }
}
