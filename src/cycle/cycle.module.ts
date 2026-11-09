import { Module } from '@nestjs/common';
import { PolymarketModule } from '../polymarket/polymarket.module';
import { ResearchModule } from '../research/research.module';
import { ForecastModule } from '../forecast/forecast.module';
import { DecisionModule } from '../decision/decision.module';
import { ExecutionModule } from '../execution/execution.module';
import { RiskModule } from '../risk/risk.module';
import { EvolutionModule } from '../evolution/evolution.module';
import { AlertingModule } from '../alerting/alerting.module';
import { PortfolioModule } from '../portfolio/portfolio.module';
import { AuditModule } from '../audit/audit.module';
import { DbModule } from '../db/db.module';
import { MainCycleService } from './main-cycle.service';
import { LightTriggerService } from './light-trigger.service';
import { CycleSchedulerService } from './cycle-scheduler.service';

@Module({
  imports: [
    PolymarketModule, ResearchModule, ForecastModule, DecisionModule,
    ExecutionModule, RiskModule, EvolutionModule, AlertingModule,
    PortfolioModule, AuditModule, DbModule,
  ],
  providers: [MainCycleService, LightTriggerService, CycleSchedulerService],
  exports: [MainCycleService, LightTriggerService],
})
export class CycleModule {}
