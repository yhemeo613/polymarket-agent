import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { PortfolioModule } from '../portfolio/portfolio.module';
import { AuditModule } from '../audit/audit.module';
import { KillSwitchService } from './kill-switch.service';
import { RegimeService } from './regime.service';
import { RiskEngine } from './risk.engine';

@Module({
  imports: [DbModule, PortfolioModule, AuditModule],
  providers: [KillSwitchService, RegimeService, RiskEngine],
  exports: [KillSwitchService, RegimeService, RiskEngine],
})
export class RiskModule {}
