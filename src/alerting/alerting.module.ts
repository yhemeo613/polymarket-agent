import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { AlertService } from './alert.service';

@Module({
  imports: [AppConfigModule],
  providers: [AlertService],
  exports: [AlertService],
})
export class AlertingModule {}
