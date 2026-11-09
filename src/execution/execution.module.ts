import { Module, Provider } from '@nestjs/common';
import { PolymarketModule } from '../polymarket/polymarket.module';
import { PortfolioModule } from '../portfolio/portfolio.module';
import { AuditModule } from '../audit/audit.module';
import { RiskModule } from '../risk/risk.module';
import { DbModule } from '../db/db.module';
import { AppConfigService } from '../config/app-config.service';
import { PortfolioService } from '../portfolio/portfolio.service';
import { LedgerService } from '../audit/ledger.service';
import { DbService } from '../db/db.service';
import { KillSwitchService } from '../risk/kill-switch.service';
import { PaperBroker } from './paper.broker';
import { LiveBroker } from './live.broker';
import { TwinOrderService } from './twin-order.service';
import type { Broker } from './broker.interface';

export const BROKER = Symbol('BROKER');

/**
 * 执行器工厂 —— 物理隔离的关键：
 * PAPER_ONLY=true（默认）时 LiveBroker **从不被构造**（其三重守卫构造函数根本不会执行），
 * 实盘代码路径对运行时完全不可达。
 * PAPER_ONLY=false 时惰性 new LiveBroker(...)，缺私钥在此 fail-fast。
 */
const brokerFactory: Provider = {
  provide: BROKER,
  useFactory: (
    config: AppConfigService,
    paper: PaperBroker,
    portfolio: PortfolioService,
    ledger: LedgerService,
    db: DbService,
    killSwitch: KillSwitchService,
  ): Broker => {
    if (config.paperOnly) return paper;
    return new LiveBroker(config, portfolio, ledger, db, killSwitch);
  },
  inject: [AppConfigService, PaperBroker, PortfolioService, LedgerService, DbService, KillSwitchService],
};

@Module({
  imports: [PolymarketModule, PortfolioModule, AuditModule, RiskModule, DbModule],
  providers: [PaperBroker, TwinOrderService, brokerFactory],
  exports: [BROKER, PaperBroker, TwinOrderService],
})
export class ExecutionModule {}
