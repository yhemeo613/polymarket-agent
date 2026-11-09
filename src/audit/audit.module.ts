import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { LedgerService } from './ledger.service';

@Module({
  imports: [DbModule],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class AuditModule {}
