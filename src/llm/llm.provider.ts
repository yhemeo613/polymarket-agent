import type { ZodType, ZodTypeDef } from 'zod';

export interface ChatJsonOptions<T> {
  system: string;
  user: string;
  /** ZodType<Output, Def, unknown>：T 固定为输出类型（default 字段不产生 undefined） */
  schema: ZodType<T, ZodTypeDef, unknown>;
  maxTokens?: number;
  /** 解析失败重试时附加的纠错说明 */
  repairHint?: string;
}

/**
 * LLM 抽象层：只做"文本进、结构化 JSON 出"。
 * 钱的计算、下单决策永远不经过这里（架构铁律）。
 */
export interface LlmProvider {
  readonly name: string;
  chatJSON<T>(opts: ChatJsonOptions<T>): Promise<T>;
}
