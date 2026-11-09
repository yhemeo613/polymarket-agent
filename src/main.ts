import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { StrategyStore } from './evolution/strategy.store';
import { AlertService } from './alerting/alert.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const config = app.get(AppConfigService);

  // 出站代理：axios 识别 HTTP(S)_PROXY 环境变量（Gamma/CLOB 可能需要代理可达）
  if (config.proxyUrl) {
    process.env.HTTP_PROXY = process.env.HTTP_PROXY ?? config.proxyUrl;
    process.env.HTTPS_PROXY = process.env.HTTPS_PROXY ?? config.proxyUrl;
    process.env.NO_PROXY = process.env.NO_PROXY ?? 'localhost,127.0.0.1';
  }

  // fail-fast：非 paper 模式必须提供私钥（LiveBroker 构造守卫之外的第二道闸）
  if (!config.paperOnly && !config.walletPrivateKey) {
    throw new Error('PAPER_ONLY=false 但未提供 WALLET_PRIVATE_KEY —— 启动中止');
  }

  // 策略目录初始化（playbook/params 就位）
  app.get(StrategyStore).ensureDirs();

  app.enableShutdownHooks();
  await app.listen(config.port);
  const mode = `${config.llmEnabled ? 'research' : 'baseline'}/${config.paperOnly ? 'paper' : 'live'}`;
  // eslint-disable-next-line no-console
  console.log(`\n polymarket-agent 已启动 mode=${mode} port=${config.port}`);
  console.log(`  GET /status | POST /cycle/run | POST /ops/kill-switch\n`);
  void app.get(AlertService).alert('info', `agent 启动 mode=${mode}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('启动失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
