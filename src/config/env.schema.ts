import { z } from 'zod';

const boolLike = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .default('true');

/**
 * 全量环境配置（zod 校验，非法即启动失败）。
 * 所有可调阈值集中在这里；风控硬帽不允许运行期被 LLM 修改。
 */
export const envSchema = z.object({
  // 运行模式
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  PAPER_ONLY: boolLike,
  WALLET_PRIVATE_KEY: z.string().optional(),
  BANKROLL_USD: z.coerce.number().positive().default(500),
  TWIN_ORDERS: boolLike.default(undefined as unknown as 'true' | 'false').optional(),

  // 存储
  DB_PATH: z.string().default('./data/agent.db'),
  STRATEGY_DIR: z.string().default('./strategy'),
  KILL_SWITCH_PATH: z.string().default('./data/kill.switch'),

  // LLM
  LLM_PROVIDER: z.enum(['anthropic', 'none']).default('none'),
  ANTHROPIC_API_KEY: z.string().optional(),
  /** 兼容端点（任何 Anthropic 协议网关）；不填则用官方默认 */
  LLM_BASE_URL: z.string().url().optional(),
  /** Bearer 方式的 AUTH_TOKEN（Anthropic 协议兼容网关常用） */
  LLM_AUTH_TOKEN: z.string().optional(),
  LLM_MODEL: z.string().default('claude-sonnet-4-5'),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(1500),

  // 证据源（可选）
  TAVILY_API_KEY: z.string().optional(),

  // Polymarket
  GAMMA_HOST: z.string().url().default('https://gamma-api.polymarket.com'),
  CLOB_HOST: z.string().url().default('https://clob.polymarket.com'),
  POLYGON_CHAIN_ID: z.coerce.number().int().default(137),
  WS_ENABLED: boolLike.default(undefined as unknown as 'true' | 'false').optional(),
  /** 出站代理（如 http://127.0.0.1:7890），axios 自动识别环境变量 */
  PROXY_URL: z.string().optional(),

  // 调度（@nestjs/schedule 六位 cron：秒 分 时 日 月 周）
  CYCLE_CRON: z.string().default('0 7 * * * *'),
  LIGHT_CRON: z.string().default('0 */15 * * * *'),

  // 扫描与预测
  SCAN_LIMIT: z.coerce.number().int().positive().default(200),
  FORECAST_BATCH: z.coerce.number().int().positive().default(12),
  SCREEN_TOP_K: z.coerce.number().int().positive().default(8),
  MIN_LIQUIDITY: z.coerce.number().nonnegative().default(1000),
  MIN_VOLUME24H: z.coerce.number().nonnegative().default(5000),
  MIN_DAYS_TO_END: z.coerce.number().nonnegative().default(1),
  MAX_DAYS_TO_END: z.coerce.number().positive().default(120),
  BLACKLIST_CATEGORIES: z.string().default(''),

  // 决策
  MIN_EDGE: z.coerce.number().default(0.02),
  SLIPPAGE_BUFFER_PCT: z.coerce.number().nonnegative().default(0.005),
  KELLY_FRACTION: z.coerce.number().min(0).max(1).default(0.25),
  TAKER_FEE_DEFAULT: z.coerce.number().nonnegative().default(0.07),

  // 风控硬帽
  MAX_SINGLE_PCT: z.coerce.number().nonnegative().default(0.02),
  MAX_MARKET_PCT: z.coerce.number().nonnegative().default(0.05),
  MAX_TOTAL_PCT: z.coerce.number().nonnegative().default(0.5),
  MAX_POSITIONS: z.coerce.number().int().positive().default(20),
  MAX_OPEN_PER_EVENT: z.coerce.number().int().positive().default(3),
  DAILY_LOSS_HALT: z.coerce.number().nonnegative().default(0.05),
  DRAWDOWN_HALT: z.coerce.number().nonnegative().default(0.2),

  // 持仓退出
  TAKE_PROFIT_AT: z.coerce.number().min(0).max(1).default(0.95),
  STOP_LOSS_AT: z.coerce.number().min(0).max(1).default(0.05),

  // 告警
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  // 服务
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof envSchema>;
