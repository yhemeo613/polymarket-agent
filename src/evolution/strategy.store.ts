import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import { nowIso } from '../common/hash.util';

const PLAYBOOK_MAX_BYTES = 500 * 1024; // 超 500KB 拒绝继续追加，需人工修剪

export interface ProposedEdit {
  section: string;
  content: string;
  evidence: string;
}

/**
 * 策略文件库 —— LLM 唯一可编辑面是 strategy/playbook.md（append-only）。
 * params.json 人工管辖；LLM 的参数建议只能写入 proposals/ 目录待人工审阅。
 */
@Injectable()
export class StrategyStore {
  constructor(private config: AppConfigService) {}

  private playbookPath(): string {
    return path.join(path.resolve(this.config.strategyDir), 'playbook.md');
  }

  private proposalsDir(): string {
    return path.join(path.resolve(this.config.strategyDir), 'proposals');
  }

  ensureDirs(): void {
    fs.mkdirSync(path.resolve(this.config.strategyDir), { recursive: true });
    fs.mkdirSync(this.proposalsDir(), { recursive: true });
    if (!fs.existsSync(this.playbookPath())) {
      fs.writeFileSync(this.playbookPath(), this.initialPlaybook(), 'utf8');
    }
    const paramsPath = path.join(path.resolve(this.config.strategyDir), 'params.json');
    if (!fs.existsSync(paramsPath)) {
      fs.writeFileSync(paramsPath, JSON.stringify({ note: '人工管辖参数；LLM 建议见 proposals/' }, null, 2), 'utf8');
    }
  }

  readPlaybook(): string {
    try {
      return fs.readFileSync(this.playbookPath(), 'utf8');
    } catch {
      return '';
    }
  }

  /** 摘录给 superforecaster prompt（尾部 N 字符，最近的裁决最有参考价值） */
  excerpt(maxChars = 3000): string {
    const pb = this.readPlaybook();
    if (pb.length <= maxChars) return pb;
    return `…（截断，仅显示最近裁决）\n${pb.slice(-maxChars)}`;
  }

  /** 追加编辑（带日期头与证据引用），超限拒绝 */
  appendEdits(edits: ProposedEdit[]): { applied: number; bytes: number } {
    let pb = this.readPlaybook();
    let applied = 0;
    const header = `\n\n## 追加 @ ${nowIso()}\n`;
    let block = header;
    for (const e of edits) {
      block += `\n### ${e.section}\n${e.content}\n> 证据: ${e.evidence}\n`;
    }
    if (Buffer.byteLength(pb + block, 'utf8') > PLAYBOOK_MAX_BYTES) {
      throw new Error('playbook 超过 500KB，拒绝追加 —— 需要人工修剪');
    }
    pb += block;
    fs.writeFileSync(this.playbookPath(), pb, 'utf8');
    applied = edits.length;
    return { applied, bytes: Buffer.byteLength(pb, 'utf8') };
  }

  /** 参数建议落 proposals/（人工审阅后手动生效） */
  writeProposal(subject: string, content: unknown): string {
    const file = path.join(this.proposalsDir(), `${nowIso().replace(/[:.]/g, '-')}-${subject}.json`);
    fs.writeFileSync(file, JSON.stringify(content, null, 2), 'utf8');
    return file;
  }

  private initialPlaybook(): string {
    return `# 策略手册（playbook）

> 本文件是 LLM 复盘代理的唯一可编辑策略面（append-only）。
> 每条追加必须引用已结算市场证据；单类别 n<15 禁止类别结论。
> 编辑历史即实验日志 —— 请保持 git 提交习惯。

## 使用规约
1. 每次编辑由复盘代理在结算后提出，每轮 ≤2 条。
2. 内容必须是可操作的裁决（"做/不做/如何修正概率"），禁止空泛表述。
3. 引用格式：> 证据: market_id + 实际结果。

## 初始基准率框架（人工初始化，非 LLM 编辑）
- 政治类事件：市场定价通常校准良好，默认不做正 edge 交易，除非证据链显著。
- 加密价格类（当日 up/down）：波动驱动，考虑噪声主导，慎入。
- 体育类：注意 secondsDelay 撮合延迟与信息延迟。
`;
  }
}
