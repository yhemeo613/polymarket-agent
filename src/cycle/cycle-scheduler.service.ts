import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CronJob } from 'cron';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AppConfigService } from '../config/app-config.service';
import { MainCycleService } from './main-cycle.service';
import { LightTriggerService } from './light-trigger.service';

/**
 * 动态 cron 调度器（cron 表达式来自 env，启动时注册）：
 * - 主循环 CYCLE_CRON（默认每小时第 7 分钟）
 * - 轻触发 LIGHT_CRON（默认每 15 分钟）
 */
@Injectable()
export class CycleSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(CycleSchedulerService.name);

  constructor(
    private config: AppConfigService,
    private registry: SchedulerRegistry,
    private main: MainCycleService,
    private light: LightTriggerService,
  ) {}

  onModuleInit() {
    const mainJob = new CronJob(this.config.cycleCron, () => {
      void this.main.runOnce('cron').catch((err) => this.logger.error(`主循环 cron 异常: ${String(err)}`));
    });
    this.registry.addCronJob('main-cycle', mainJob);
    mainJob.start();

    const lightJob = new CronJob(this.config.lightCron, () => {
      void this.light.runLight().catch((err) => this.logger.error(`轻触发异常: ${String(err)}`));
    });
    this.registry.addCronJob('light-trigger', lightJob);
    lightJob.start();

    this.logger.log(`调度已注册：主循环 "${this.config.cycleCron}"，轻触发 "${this.config.lightCron}"`);
  }
}
