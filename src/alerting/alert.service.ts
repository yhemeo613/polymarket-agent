import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { AppConfigService } from '../config/app-config.service';

/**
 * 告警服务：Telegram（可选）+ pino 日志。
 * 无配置自动降级 console —— 无人值守的最后一道通知线。
 */
@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);

  constructor(private config: AppConfigService) {}

  async alert(level: 'info' | 'warn' | 'error', title: string, body = ''): Promise<void> {
    const line = `[${level.toUpperCase()}] ${title}${body ? `\n${body}` : ''}`;
    if (level === 'error') this.logger.error(line);
    else if (level === 'warn') this.logger.warn(line);
    else this.logger.log(line);

    if (!this.config.telegramEnabled) return;
    try {
      await axios.post(
        `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`,
        {
          chat_id: this.config.telegramChatId,
          text: line.slice(0, 4000),
          disable_web_page_preview: true,
        },
        { timeout: 8000 },
      );
    } catch (err) {
      this.logger.warn(`Telegram 发送失败: ${String(err).slice(0, 120)}`);
    }
  }
}
