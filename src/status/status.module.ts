import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RiskModule } from '../risk/risk.module';
import { PortfolioModule } from '../portfolio/portfolio.module';
import { ForecastModule } from '../forecast/forecast.module';
import { EvolutionModule } from '../evolution/evolution.module';
import { AuditModule } from '../audit/audit.module';
import { DbModule } from '../db/db.module';
import { CycleModule } from '../cycle/cycle.module';
import { AlertingModule } from '../alerting/alerting.module';
import { DecisionModule } from '../decision/decision.module';
import { StatusService } from './status.service';
import { StatusController } from './status.controller';

@Module({
  imports: [
    ConfigModule,
    RiskModule, PortfolioModule, ForecastModule, EvolutionModule,
    AuditModule, DbModule, CycleModule, AlertingModule, DecisionModule,
  ],
  providers: [StatusService],
  controllers: [StatusController],
})
export class StatusModule {}
