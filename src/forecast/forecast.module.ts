import { Module } from '@nestjs/common';
import { PolymarketModule } from '../polymarket/polymarket.module';
import { PortfolioModule } from '../portfolio/portfolio.module';
import { AuditModule } from '../audit/audit.module';
import { DbModule } from '../db/db.module';
import { EvolutionModule } from '../evolution/evolution.module';
import { DecisionModule } from '../decision/decision.module';
import { ForecastJournal } from './forecast.journal';
import { SettleService } from './settle.service';

@Module({
  imports: [PolymarketModule, PortfolioModule, AuditModule, DbModule, EvolutionModule, DecisionModule],
  providers: [ForecastJournal, SettleService],
  exports: [ForecastJournal, SettleService],
})
export class ForecastModule {}
