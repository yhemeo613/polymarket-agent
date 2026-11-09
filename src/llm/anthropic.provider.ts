import Anthropic from '@anthropic-ai/sdk';
import type { ZodType } from 'zod';
import { AppConfigService } from '../config/app-config.service';
import type { ChatJsonOptions, LlmProvider } from './llm.provider';

/** 从模型输出中提取 JSON（容忍代码围栏与前后杂文） */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('输出中未找到 JSON 对象');
  return JSON.parse(candidate.slice(start, end + 1));
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(private config: AppConfigService) {
    // 支持两种凭证：官方 x-api-key，或兼容网关的 Bearer AUTH_TOKEN（如智谱 GLM）
    this.client = new Anthropic({
      ...(config.anthropicApiKey ? { apiKey: config.anthropicApiKey } : {}),
      ...(config.llmAuthToken ? { authToken: config.llmAuthToken } : {}),
      ...(config.llmBaseUrl ? { baseURL: config.llmBaseUrl } : {}),
    });
  }

  async chatJSON<T>(opts: ChatJsonOptions<T>): Promise<T> {
    let attempt = 0;
    let lastError: unknown;
    const maxAttempts = 2; // 失败重试 1 次
    while (attempt < maxAttempts) {
      attempt++;
      const repair = attempt > 1 && opts.repairHint ? `\n\n注意：${opts.repairHint}` : '';
      // 流式调用：大 max_tokens（如 128K）下 SDK 强制要求流式，且天然避免长请求超时
      const stream = this.client.messages.stream({
        model: this.config.llmModel,
        max_tokens: opts.maxTokens ?? this.config.llmMaxTokens,
        system: opts.system + repair,
        messages: [{ role: 'user', content: opts.user }],
      });
      const msg = await stream.finalMessage();
      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      try {
        const parsed = opts.schema.safeParse(extractJson(text));
        if (!parsed.success) {
          lastError = new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
          continue;
        }
        return parsed.data;
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(`LLM JSON 输出解析失败（${attempt} 次）: ${String(lastError)}`);
  }
}
