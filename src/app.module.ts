import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigModule, ENV } from './config/config.module';
import type { Env } from './config/env.schema';
import { DbModule } from './db/db.module';
import { PortfolioModule } from './portfolio/portfolio.module';
import { PolymarketModule } from './polymarket/polymarket.module';
import { LlmModule } from './llm/llm.module';
import { ResearchModule } from './research/research.module';
import { DecisionModule } from './decision/decision.module';
import { RiskModule } from './risk/risk.module';
import { AuditModule } from './audit/audit.module';
import { ExecutionModule } from './execution/execution.module';
import { ForecastModule } from './forecast/forecast.module';
import { EvolutionModule } from './evolution/evolution.module';
import { AlertingModule } from './alerting/alerting.module';
import { CycleModule } from './cycle/cycle.module';
import { StatusModule } from './status/status.module';

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          autoLogging: { ignore: (req) => req.url === '/status' }, // 状态轮询不刷屏
          transport:
            env.NODE_ENV !== 'production'
              ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } }
              : undefined,
        },
      }),
    }),
    ScheduleModule.forRoot(),
    AppConfigModule,
    DbModule,
    PortfolioModule,
    PolymarketModule,
    LlmModule,
    ResearchModule,
    DecisionModule,
    RiskModule,
    AuditModule,
    ExecutionModule,
    ForecastModule,
    EvolutionModule,
    AlertingModule,
    CycleModule,
    StatusModule,
  ],
})
export class AppModule {}
