import { Inject, Injectable } from '@nestjs/common';
import type { Env } from './env.schema';
import { ENV } from './tokens';

/**
 * 类型安全配置门面。模块一律注入本服务，不直接读 process.env。
 */
@Injectable()
export class AppConfigService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  get nodeEnv() { return this.env.NODE_ENV; }
  get isProd() { return this.env.NODE_ENV === 'production'; }
  get port() { return this.env.PORT; }
  get logLevel() { return this.env.LOG_LEVEL; }

  // 运行模式
  get paperOnly() { return this.env.PAPER_ONLY; }
  get walletPrivateKey() { return this.env.WALLET_PRIVATE_KEY; }
  get bankrollUsd() { return this.env.BANKROLL_USD; }
  get twinOrders() { return this.env.TWIN_ORDERS ?? false; }

  // 存储
  get dbPath() { return this.env.DB_PATH; }
  get strategyDir() { return this.env.STRATEGY_DIR; }
  get killSwitchPath() { return this.env.KILL_SWITCH_PATH; }

  // LLM
  get llmProvider() { return this.env.LLM_PROVIDER; }
  get llmEnabled() {
    return this.env.LLM_PROVIDER === 'anthropic' && !!(this.env.ANTHROPIC_API_KEY || this.env.LLM_AUTH_TOKEN);
  }
  get anthropicApiKey() { return this.env.ANTHROPIC_API_KEY; }
  get llmBaseUrl() { return this.env.LLM_BASE_URL; }
  get llmAuthToken() { return this.env.LLM_AUTH_TOKEN; }
  get llmModel() { return this.env.LLM_MODEL; }
  get llmMaxTokens() { return this.env.LLM_MAX_TOKENS; }

  // 证据源
  get tavilyApiKey() { return this.env.TAVILY_API_KEY; }

  // Polymarket
  get gammaHost() { return this.env.GAMMA_HOST; }
  get clobHost() { return this.env.CLOB_HOST; }
  get chainId() { return this.env.POLYGON_CHAIN_ID; }
  get wsEnabled() { return this.env.WS_ENABLED ?? false; }
  get proxyUrl() { return this.env.PROXY_URL; }

  // 调度
  get cycleCron() { return this.env.CYCLE_CRON; }
  get lightCron() { return this.env.LIGHT_CRON; }

  // 扫描
  get scanLimit() { return this.env.SCAN_LIMIT; }
  get forecastBatch() { return this.env.FORECAST_BATCH; }
  get screenTopK() { return this.env.SCREEN_TOP_K; }
  get minLiquidity() { return this.env.MIN_LIQUIDITY; }
  get minVolume24h() { return this.env.MIN_VOLUME24H; }
  get minDaysToEnd() { return this.env.MIN_DAYS_TO_END; }
  get maxDaysToEnd() { return this.env.MAX_DAYS_TO_END; }
  get blacklistCategories(): string[] {
    return this.env.BLACKLIST_CATEGORIES.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  }

  // 决策
  get minEdge() { return this.env.MIN_EDGE; }
  get slippageBufferPct() { return this.env.SLIPPAGE_BUFFER_PCT; }
  get kellyFraction() { return this.env.KELLY_FRACTION; }
  get takerFeeDefault() { return this.env.TAKER_FEE_DEFAULT; }

  // 风控硬帽
  get maxSinglePct() { return this.env.MAX_SINGLE_PCT; }
  get maxMarketPct() { return this.env.MAX_MARKET_PCT; }
  get maxTotalPct() { return this.env.MAX_TOTAL_PCT; }
  get maxPositions() { return this.env.MAX_POSITIONS; }
  get maxOpenPerEvent() { return this.env.MAX_OPEN_PER_EVENT; }
  get dailyLossHalt() { return this.env.DAILY_LOSS_HALT; }
  get drawdownHalt() { return this.env.DRAWDOWN_HALT; }

  // 退出
  get takeProfitAt() { return this.env.TAKE_PROFIT_AT; }
  get stopLossAt() { return this.env.STOP_LOSS_AT; }

  // 告警
  get telegramBotToken() { return this.env.TELEGRAM_BOT_TOKEN; }
  get telegramChatId() { return this.env.TELEGRAM_CHAT_ID; }
  get telegramEnabled() { return !!this.env.TELEGRAM_BOT_TOKEN && !!this.env.TELEGRAM_CHAT_ID; }
}
