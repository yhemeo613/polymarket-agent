import { Module } from '@nestjs/common';
import { PolymarketModule } from '../polymarket/polymarket.module';
import { LlmModule } from '../llm/llm.module';
import { EvidenceService } from './evidence.service';
import { MarketFilterService } from './market-filter.service';
import { ForecasterService } from './forecaster.service';

@Module({
  imports: [PolymarketModule, LlmModule],
  providers: [EvidenceService, MarketFilterService, ForecasterService],
  exports: [MarketFilterService, ForecasterService, EvidenceService],
})
export class ResearchModule {}
