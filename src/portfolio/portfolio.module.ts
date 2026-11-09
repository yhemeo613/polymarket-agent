import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { PortfolioService } from './portfolio.service';

@Module({
  imports: [DbModule],
  providers: [PortfolioService],
  exports: [PortfolioService],
})
export class PortfolioModule {}
