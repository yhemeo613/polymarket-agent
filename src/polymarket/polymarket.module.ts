import { Module } from '@nestjs/common';
import { GammaApi } from './gamma.api';
import { ClobMarketApi } from './clob.market.api';
import { OrderBookService } from './orderbook.service';
import { WsBookSubscriber } from './ws.book.subscriber';

@Module({
  providers: [GammaApi, ClobMarketApi, OrderBookService, WsBookSubscriber],
  exports: [GammaApi, ClobMarketApi, OrderBookService],
})
export class PolymarketModule {}
