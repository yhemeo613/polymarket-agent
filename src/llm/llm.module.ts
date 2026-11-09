import { Module, Provider } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/app-config.service';
import { AnthropicProvider } from './anthropic.provider';
import type { LlmProvider } from './llm.provider';

export const LLM_CLIENT = Symbol('LLM_CLIENT');

const providerFactory: Provider = {
  provide: LLM_CLIENT,
  useFactory: (config: AppConfigService): LlmProvider | null =>
    config.llmEnabled ? new AnthropicProvider(config) : null,
  inject: [AppConfigService],
};

/**
 * LLM 客户端模块。
 * 无 key 时 LLM_CLIENT 为 null —— research 层据此进入 baseline 模式
 * （p̂=市场价，即 H0 基线），全链路照常运行，用于验证管线与采集校准数据。
 */
@Module({
  imports: [AppConfigModule],
  providers: [providerFactory],
  exports: [LLM_CLIENT],
})
export class LlmModule {}
