import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { AuditModule } from '../audit/audit.module';
import { DecisionModule } from '../decision/decision.module';
import { LlmModule } from '../llm/llm.module';
import { ScoreService } from './score.service';
import { ShadowPromotionService } from './shadow.promotion.service';
import { RetroService } from './retro.service';
import { StrategyStore } from './strategy.store';

@Module({
  imports: [DbModule, AuditModule, DecisionModule, LlmModule],
  providers: [ScoreService, ShadowPromotionService, RetroService, StrategyStore],
  exports: [ScoreService, ShadowPromotionService, RetroService, StrategyStore],
})
export class EvolutionModule {}
