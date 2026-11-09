import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import { nowIso } from '../common/hash.util';

/**
 * 进程外 kill switch：哨兵文件。
 * 任何外部进程 `touch data/kill.switch` 即全停；进程内 API 亦走同一文件。
 * 下单路径每次校验都会读两次（await I/O 后二次复查，防异步竞态）。
 */
@Injectable()
export class KillSwitchService {
  constructor(private config: AppConfigService) {}

  private get file(): string {
    return path.resolve(this.config.killSwitchPath);
  }

  /** 哨兵是否激活（单次检查） */
  engaged(): boolean {
    try {
      return fs.existsSync(this.file);
    } catch {
      return false;
    }
  }

  /** 双重检查：调用方在 await 之后再次调用本方法确认 */
  engagedTwiceVerified(): boolean {
    const first = this.engaged();
    if (!first) return false;
    // 小间隔二次读，覆盖"检查通过后立即被外部置位"的窗口
    const second = this.engaged();
    return first || second;
  }

  engage(reason = 'manual'): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ engagedAt: nowIso(), reason }), 'utf8');
  }

  release(): void {
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      /* 不存在则忽略 */
    }
  }
}
