import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import { AppConfigService } from '../config/app-config.service';
import { StatusService } from '../status/status.service';
import { ScoreService } from '../evolution/score.service';
import { ForecastJournal } from '../forecast/forecast.journal';
import { PortfolioService } from '../portfolio/portfolio.service';
import { KillSwitchService } from '../risk/kill-switch.service';
import { MainCycleService } from '../cycle/main-cycle.service';
import { DbService } from '../db/db.service';
import type { ForecastRow } from '../db/schema';

const fmt = (n: number | null | undefined, d = 2) => (n == null ? '—' : Number(n).toFixed(d));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Telegram 交互 Bot：long polling 接收命令 / 按钮 → 回复对应内容。
 * 安全：仅响应 TELEGRAM_CHAT_ID 配置的会话（bot 是公开的，必须防他人控制）。
 * 菜单按钮通过 reply_markup 常驻键盘；命令同时注册 / 指令面板。
 */
@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  private offset: number | null = null;
  private polling = true;

  constructor(
    private config: AppConfigService,
    private statusService: StatusService,
    private score: ScoreService,
    private journal: ForecastJournal,
    private portfolio: PortfolioService,
    private killSwitch: KillSwitchService,
    private mainCycle: MainCycleService,
    private db: DbService,
  ) {}

  private get api(): string {
    return `https://api.telegram.org/bot${this.config.telegramBotToken}`;
  }

  private get ownerId(): string {
    return String(this.config.telegramChatId ?? '');
  }

  onModuleInit(): void {
    if (!this.config.telegramEnabled) {
      this.logger.log('Telegram 未配置 —— 交互 Bot 不启动');
      return;
    }
    this.polling = true;
    void this.registerCommands();
    void this.pollLoop();
    this.logger.log('Telegram 交互 Bot 已启动（long polling）');
  }

  onModuleDestroy(): void {
    this.polling = false;
  }

  private async registerCommands(): Promise<void> {
    try {
      await axios.post(`${this.api}/setMyCommands`, {
        commands: [
          { command: 'status', description: '📊 运行状态' },
          { command: 'score', description: '📈 评分仪表盘' },
          { command: 'positions', description: '💼 当前持仓' },
          { command: 'recent', description: '🕘 最近预测' },
          { command: 'run', description: '🔄 手动触发一轮主循环' },
          { command: 'kill', description: '⛔ 紧急停止' },
          { command: 'resume', description: '▶️ 恢复运行' },
        ],
      }, { timeout: 10_000 });
    } catch (err) {
      this.logger.warn(`注册命令面板失败: ${String(err).slice(0, 120)}`);
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        const resp = await axios.get(`${this.api}/getUpdates`, {
          params: { offset: this.offset ?? undefined, timeout: 25 },
          timeout: 35_000,
        });
        const updates = (resp.data?.result ?? []) as Array<Record<string, unknown>>;
        for (const u of updates) {
          this.offset = Number(u.update_id) + 1;
          void this.handleUpdate(u);
        }
        if (this.offset == null && updates.length > 0) {
          // 首次启动跳过历史消息，只响应新消息
          this.offset = Math.max(...updates.map((u) => Number(u.update_id))) + 1;
        }
      } catch (err) {
        this.logger.warn(`getUpdates 失败，5s 后重试: ${String(err).slice(0, 120)}`);
        await sleep(5000);
      }
    }
  }

  private async handleUpdate(update: Record<string, unknown>): Promise<void> {
    const msg = (update.message ?? update.edited_message) as Record<string, unknown> | undefined;
    if (!msg) return;
    const chatId = String((msg.chat as Record<string, unknown> | undefined)?.id ?? '');
    if (chatId !== this.ownerId) {
      // 非主人：静默忽略（不回复，避免暴露 bot 在被控制）
      this.logger.warn(`忽略来自非授权会话的消息 chat=${chatId}`);
      return;
    }
    const text = String(msg.text ?? '').trim();
    if (!text) return;
    try {
      await this.route(text, chatId);
    } catch (err) {
      await this.send(chatId, `⚠️ 处理失败: ${String(err).slice(0, 200)}`);
    }
  }

  private async route(text: string, chatId: string): Promise<void> {
    const t = text.toLowerCase();
    if (t === '/start') {
      await this.send(chatId, [
        '🤖 polymarket-agent 已连接。',
        '',
        '可用命令（或点下方键盘按钮）:',
        '/status 运行状态 · /score 评分 · /positions 持仓',
        '/recent 最近预测 · /run 手动一轮',
        '/kill 紧急停止 · /resume 恢复',
      ].join('\n'));
      return;
    }
    if (t === '/status' || text.includes('状态')) return void this.send(chatId, this.statusText());
    if (t === '/score' || text.includes('评分')) return void this.send(chatId, this.scoreText());
    if (t === '/positions' || text.includes('持仓')) return void this.send(chatId, this.positionsText());
    if (t === '/recent' || text.includes('最近')) return void this.send(chatId, this.recentText());
    if (t === '/run' || text.includes('手动')) {
      if (this.mainCycle.busy) {
        await this.send(chatId, '⏳ 主循环正在运行中，请等它结束后再触发。');
        return;
      }
      await this.send(chatId, '🔄 已触发主循环（research 模式约 10 分钟），完成后推送摘要。');
      void this.mainCycle.runOnce('manual').catch(() => undefined);
      return;
    }
    if (t === '/kill' || text.includes('暂停') || text.includes('停止')) {
      this.killSwitch.engage('telegram');
      await this.send(chatId, '⛔ KILL SWITCH 已置位 —— 主循环与轻触发全部跳过。恢复请发 /resume');
      return;
    }
    if (t === '/resume' || text.includes('恢复')) {
      this.killSwitch.release();
      await this.send(chatId, '▶️ kill switch 已解除，下一轮调度恢复运行。');
      return;
    }
    if (t === '/help' || text.includes('帮助')) {
      await this.send(chatId, '命令: /status /score /positions /recent /run /kill /resume');
      return;
    }
    await this.send(chatId, '未识别的命令，发 /help 查看列表。');
  }

  private statusText(): string {
    const s = this.statusService.snapshot();
    const w = s.wallet;
    const lines = [
      '📊 运行状态',
      `模式: ${s.mode.llm}/${s.mode.broker}${s.mode.twinOrders ? ' +孪生单' : ''} · kill switch: ${s.killSwitch ? '⛔ 已置位' : '✅ 正常'}`,
      `💰 现金 $${fmt(w.cashUsd)} · 敞口 $${fmt(w.totalExposure)} · 持仓 ${w.openPositions} · 回撤 ${pct(w.drawdown)} · 日盈亏 ${w.dailyPnl >= 0 ? '+' : ''}$${fmt(w.dailyPnl)}`,
      `预测: 总 ${s.forecasts.total} · 进行中 ${s.forecasts.open} · 已结算 ${s.forecasts.settled} · 下注 ${s.forecasts.bets}`,
      `🎯 brier_delta ${signed(s.score.brierDelta, 4)}（n=${s.score.settled}，占优 ${(s.score.brierDeltaWins * 100).toFixed(0)}%）`,
      `📖 账本 ${s.ledgerVerify.ok ? `✅ 完整（${s.ledgerVerify.total} 条）` : `🚨 第 ${s.ledgerVerify.brokenAtId} 条被篡改`}`,
    ];
    if (s.lastCycle) {
      lines.push(`⏱ 上一轮 #${s.lastCycle.id} ${s.lastCycle.finishedAt ? `结束于 ${s.lastCycle.finishedAt}` : '运行中…'}`);
    }
    if (s.openPositions.length) {
      lines.push('', '💼 持仓:');
      for (const p of s.openPositions) lines.push(`  · ${fmt(p.shares)}份@$${fmt(p.avgPrice, 3)}（$${fmt(p.costUsd)}）${(p.question ?? '').slice(0, 36)}`);
    }
    return lines.join('\n');
  }

  private scoreText(): string {
    const d = this.score.summary();
    const lines = [
      '📈 评分仪表盘',
      `已结算 ${d.settled} · agent brier ${fmt(d.meanBrierAgent, 4)} vs 市场 ${fmt(d.meanBrierMarket, 4)}`,
      `🎯 brier_delta ${signed(d.brierDelta, 4)}（<0 表示跑赢市场）· 占优 ${(d.brierDeltaWins * 100).toFixed(0)}%`,
      `幸运z ${d.luckZ == null ? '—' : fmt(d.luckZ, 2)} · 下注 n=${d.bets.n} · ROI ${d.bets.roi == null ? '—' : pct(d.bets.roi)}（已实现 $${fmt(d.bets.realizedPnl)}）`,
    ];
    const buckets = d.calibration.filter((b) => b.n > 0);
    if (buckets.length) {
      lines.push('', '校准（bias=实际−预测，|bias|<0.05 为佳）:');
      for (const b of buckets) lines.push(`  ${b.lo.toFixed(1)}-${b.hi.toFixed(1)} n=${b.n} bias ${signed(b.bias, 3)}`);
    }
    const sweep = this.score.thresholdSweep().filter((t) => t.n > 0);
    if (sweep.length) {
      lines.push('', '阈值扫描（反事实平注 ROI）:');
      for (const t2 of sweep) lines.push(`  min_edge ${(t2.minEdge * 100).toFixed(0)}% n=${t2.n} ROI ${t2.flatBetRoi == null ? '—' : pct(t2.flatBetRoi)}`);
    }
    return lines.join('\n');
  }

  private positionsText(): string {
    const positions = this.portfolio.openPositions();
    if (!positions.length) return '💼 当前无持仓。';
    const lines = [`💼 持仓 ${positions.length} 个（成本口径）:`];
    for (const p of positions) {
      lines.push(`  #${p.id} ${fmt(p.shares)} 份 @ $${fmt(p.avgPrice, 3)} = $${fmt(p.costUsd)} · ${(p.question ?? '').slice(0, 40)}`);
    }
    return lines.join('\n');
  }

  private recentText(): string {
    const rows = this.db.all<ForecastRow>(
      'SELECT * FROM forecasts ORDER BY id DESC LIMIT 5',
    );
    if (!rows.length) return '🕘 暂无预测记录。';
    const lines = ['🕘 最近 5 条预测:'];
    for (const f of rows) {
      const p = f.pFinal != null ? `p̂=${fmt(f.pFinal, 3)}` : 'p̂=—';
      const mid = f.marketMidAtCall != null ? `市场=${fmt(f.marketMidAtCall, 3)}` : '';
      lines.push(`  #${f.id} [${f.decision}] ${p} ${mid} · ${(f.question ?? '').slice(0, 34)}${f.skipReason ? `（${f.skipReason.slice(0, 30)}）` : ''}`);
    }
    return lines.join('\n');
  }

  private keyboard() {
    return {
      keyboard: [
        [{ text: '📊 状态' }, { text: '📈 评分' }],
        [{ text: '💼 持仓' }, { text: '🕘 最近预测' }],
        [{ text: '🔄 手动一轮' }, { text: '⛔ 暂停' }, { text: '▶️ 恢复' }],
      ],
      resize_keyboard: true,
    };
  }

  private async send(chatId: string, text: string): Promise<void> {
    try {
      await axios.post(`${this.api}/sendMessage`, {
        chat_id: Number(chatId),
        text: text.slice(0, 4000),
        reply_markup: this.keyboard(),
        disable_web_page_preview: true,
      }, { timeout: 10_000 });
    } catch (err) {
      this.logger.warn(`发送失败: ${String(err).slice(0, 120)}`);
    }
  }
}

const pct = (n: number | null | undefined) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`);
const signed = (n: number, d = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}`;
