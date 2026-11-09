import { Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { StatusService } from './status.service';
import { MainCycleService } from '../cycle/main-cycle.service';
import { LightTriggerService } from '../cycle/light-trigger.service';
import { KillSwitchService } from '../risk/kill-switch.service';
import { LedgerService } from '../audit/ledger.service';
import { ScoreService } from '../evolution/score.service';
import { RulesService, RuleDef } from '../decision/rules.service';
import { AlertService } from '../alerting/alert.service';

const KillSwitchBody = z.object({
  enabled: z.boolean(),
  reason: z.string().default('ops-api'),
});

const RuleBody = z.object({
  name: z.string().min(1),
  def: z.union([
    z.object({ type: z.literal('shift_prob'), delta: z.number() }),
    z.object({ type: z.literal('cap_extremes'), lo: z.number(), hi: z.number() }),
    z.object({ type: z.literal('exclude_category'), category: z.string().min(1) }),
  ]),
});

/**
 * Ops API（无 UI 的运维面）：
 * GET  /status              运行快照
 * POST /cycle/run           手动触发主循环 {trigger?}
 * POST /ops/kill-switch     置位/解除 kill switch（与哨兵文件同机制）
 * GET  /ops/ledger/verify   账本完整性校验
 * GET  /ops/score           评分仪表盘 + 阈值扫描
 * POST /ops/rules           创建影子规则（人工通道）
 */
@Controller()
export class StatusController {
  constructor(
    private statusService: StatusService,
    private mainCycle: MainCycleService,
    private light: LightTriggerService,
    private killSwitch: KillSwitchService,
    private ledger: LedgerService,
    private score: ScoreService,
    private rules: RulesService,
    private alert: AlertService,
  ) {}

  @Get('status')
  status() {
    return this.statusService.snapshot();
  }

  @Post('cycle/run')
  async runCycle(@Body() body: { trigger?: 'manual' | 'light' }) {
    const summary = body?.trigger === 'light'
      ? await this.light.runLight()
      : await this.mainCycle.runOnce('manual');
    return { ok: true, summary };
  }

  @Post('ops/kill-switch')
  setKillSwitch(@Body() body: unknown) {
    const parsed = KillSwitchBody.safeParse(body);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    if (parsed.data.enabled) {
      this.killSwitch.engage(parsed.data.reason);
      void this.alert.alert('warn', 'KILL SWITCH 置位', parsed.data.reason);
    } else {
      this.killSwitch.release();
      void this.alert.alert('info', 'KILL SWITCH 解除', parsed.data.reason);
    }
    return { ok: true, engaged: this.killSwitch.engaged() };
  }

  @Get('ops/ledger/verify')
  verifyLedger() {
    return this.ledger.verify();
  }

  @Get('ops/score')
  scoreDashboard() {
    return {
      summary: this.score.summary(),
      thresholdSweep: this.score.thresholdSweep(),
      rules: this.rules.listByStatus('SHADOW').concat(this.rules.listByStatus('ACTIVE')),
    };
  }

  @Post('ops/rules')
  createRule(@Body() body: unknown) {
    const parsed = RuleBody.safeParse(body);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    const rule = this.rules.createShadow(parsed.data.name, parsed.data.def as RuleDef);
    return { ok: true, rule };
  }
}
