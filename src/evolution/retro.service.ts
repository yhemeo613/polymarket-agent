import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { AppConfigService } from '../config/app-config.service';
import { LLM_CLIENT } from '../llm/llm.module';
import type { LlmProvider } from '../llm/llm.provider';
import { RETRO_SYSTEM } from '../research/prompts';
import { StrategyStore, ProposedEdit } from './strategy.store';
import { LedgerService } from '../audit/ledger.service';

const RetroOut = z.object({
  edits: z
    .array(
      z.object({
        section: z.string().min(1),
        content: z.string().min(1),
        evidence: z.string().min(1),
      }),
    )
    .max(2) // 每轮 ≤2 条（硬约束防漂移）
    .default([]),
  notes: z.string().default(''),
});

/**
 * 复盘层（LLM 三问归因 → playbook 受限编辑）：
 * - 每个已结算头寸三问：估计错了 / 成交差 / 方差正常？
 * - n<15 的类别禁止结论（prompt 硬约束）
 * - 编辑必须引用已结算证据；超限/无证据直接拒绝落盘
 * - baseline 模式（无 LLM）为 no-op
 */
@Injectable()
export class RetroService {
  private readonly logger = new Logger(RetroService.name);

  constructor(
    private db: DbService,
    private config: AppConfigService,
    private store: StrategyStore,
    private ledger: LedgerService,
    @Optional() @Inject(LLM_CLIENT) private llm: LlmProvider | null,
  ) {}

  async runRetro(): Promise<{ ran: boolean; applied: number; notes: string }> {
    if (!this.llm) {
      return { ran: false, applied: 0, notes: 'baseline 模式：复盘跳过（无 LLM）' };
    }
    // 取最近已结算、尚未复盘的预测（复用 rationale 作为证据载体）
    const rows = this.db.all<{
      id: number; marketId: string; question: string; category: string | null;
      pFinal: number | null; marketMidAtCall: number | null; y: number | null;
      brierDelta: number | null; decision: string; result: string | null;
    }>(
      `SELECT id, market_id, question, category, p_final, market_mid_at_call, y, brier_delta, decision, result
       FROM forecasts WHERE status = 'SETTLED' ORDER BY id DESC LIMIT 30`,
    );
    if (!rows.length) return { ran: true, applied: 0, notes: '无已结算样本' };

    const n = rows.length;
    const user = [
      `已结算预测样本（n=${n}，注意：单一类别 n<15 时禁止该类别结论）：`,
      ...rows.map(
        (r) =>
          `- [${r.marketId}] ${r.question}\n  类别=${r.category ?? '?'} 决策=${r.decision} 结果=${r.result} ` +
          `p_final=${r.pFinal?.toFixed(3) ?? '?'} 市场mid=${r.marketMidAtCall?.toFixed(3) ?? '?'} ` +
          `y=${r.y} brier_delta=${r.brierDelta?.toFixed(4) ?? '?'}`,
      ),
      '',
      '对每个头寸回答三问（估计错/成交差/方差正常），然后决定是否值得把教训写进 playbook。',
      '没有可提炼教训就返回空 edits。禁止提出风控参数修改建议。',
    ].join('\n');

    const out = await this.llm.chatJSON({ system: RETRO_SYSTEM, user, schema: RetroOut });

    let applied = 0;
    if (out.edits.length) {
      const edits: ProposedEdit[] = out.edits.map((e) => ({
        section: e.section.slice(0, 60),
        content: e.content.slice(0, 400),
        evidence: e.evidence.slice(0, 160),
      }));
      const res = this.store.appendEdits(edits);
      applied = res.applied;
      this.ledger.append('playbook_edit', { edits, bytes: res.bytes });
      this.logger.log(`playbook 追加 ${applied} 条编辑（${res.bytes} bytes）`);
    }
    return { ran: true, applied, notes: out.notes.slice(0, 300) };
  }
}
