import { Module } from '@nestjs/common';
import { PortfolioModule } from '../portfolio/portfolio.module';
import { RiskModule } from '../risk/risk.module';
import { ForecastModule } from '../forecast/forecast.module';
import { EvolutionModule } from '../evolution/evolution.module';
import { DecisionModule } from '../decision/decision.module';
import { CycleModule } from '../cycle/cycle.module';
import { StatusModule } from '../status/status.module';
import { TelegramBotService } from './telegram-bot.service';

/**
 * Telegram 交互 Bot（long polling）。
 * 独立模块避免与 AlertingModule/CycleModule 形成循环依赖。
 */
@Module({
  imports: [PortfolioModule, RiskModule, ForecastModule, EvolutionModule, DecisionModule, CycleModule, StatusModule],
  providers: [TelegramBotService],
})
export class TelegramModule {}
