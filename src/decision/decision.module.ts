import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { PolymarketModule } from '../polymarket/polymarket.module';
import { CalibrationService } from './calibration.service';
import { RulesService } from './rules.service';
import { DecisionService } from './decision.service';

@Module({
  imports: [DbModule, PolymarketModule],
  providers: [CalibrationService, RulesService, DecisionService],
  exports: [CalibrationService, RulesService, DecisionService],
})
export class DecisionModule {}
