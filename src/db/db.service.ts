import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import { nowIso } from '../common/hash.util';

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  mode TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'cron',
  markets_scanned INTEGER NOT NULL DEFAULT 0,
  forecasts INTEGER NOT NULL DEFAULT 0,
  orders INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT
);
CREATE TABLE IF NOT EXISTS forecasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER,
  ts TEXT NOT NULL,
  market_id TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  event_id TEXT,
  question TEXT NOT NULL,
  category TEXT,
  end_date TEXT,
  yes_token_id TEXT,
  no_token_id TEXT,
  outcome TEXT NOT NULL DEFAULT 'YES',
  p_raw REAL, p_cal REAL, p_final REAL, confidence REAL,
  market_mid_at_call REAL, best_ask_at_call REAL,
  evidence_json TEXT, applied_rules_json TEXT,
  decision TEXT NOT NULL DEFAULT 'SKIP',
  skip_reason TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  result TEXT, y INTEGER,
  brier_agent REAL, brier_market REAL, brier_delta REAL,
  rationale TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  forecast_id INTEGER, cycle_id INTEGER,
  ts TEXT NOT NULL,
  broker TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'ENTRY',
  side TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'YES',
  token_id TEXT NOT NULL,
  market_id TEXT, condition_id TEXT,
  limit_price REAL, size_usd REAL, shares REAL,
  filled_shares REAL DEFAULT 0,
  avg_fill_price REAL, fee REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'FILLED',
  reason TEXT,
  request_json TEXT, fill_json TEXT
);
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  forecast_id INTEGER,
  market_id TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  event_id TEXT,
  question TEXT, category TEXT,
  outcome TEXT NOT NULL DEFAULT 'YES',
  token_id TEXT NOT NULL,
  shares REAL NOT NULL DEFAULT 0,
  avg_price REAL NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN',
  opened_ts TEXT NOT NULL,
  closed_ts TEXT, close_reason TEXT, realized_pnl REAL
);
CREATE TABLE IF NOT EXISTS settlements (
  condition_id TEXT PRIMARY KEY,
  market_id TEXT, question TEXT,
  result TEXT NOT NULL,
  resolved_at TEXT,
  source TEXT NOT NULL DEFAULT 'gamma',
  joined_ts TEXT
);
CREATE TABLE IF NOT EXISTS shadow_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  def_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SHADOW',
  n INTEGER NOT NULL DEFAULT 0,
  mean_diff REAL NOT NULL DEFAULT 0,
  m2 REAL NOT NULL DEFAULT 0,
  t_stat REAL,
  verdict TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT,
  payload_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wallet (
  id INTEGER PRIMARY KEY,
  cash_usd REAL NOT NULL,
  peak_equity REAL NOT NULL,
  day_anchor_equity REAL NOT NULL,
  day_key TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_forecasts_status ON forecasts(status);
CREATE INDEX IF NOT EXISTS idx_forecasts_condition ON forecasts(condition_id);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_orders_forecast ON orders(forecast_id);
`;

/**
 * SQLite（Node 22 内置 node:sqlite，零原生编译依赖）。
 * 同步 API —— 决策路径一致性优先，量级（<1e4 行/表）下性能足够。
 */
@Injectable()
export class DbService implements OnModuleInit {
  private sqlite!: DatabaseSync;

  constructor(private readonly config: AppConfigService) {}

  onModuleInit() {
    const requested = this.config.dbPath;
    if (requested === ':memory:') {
      this.sqlite = new DatabaseSync(':memory:');
    } else {
      const file = path.resolve(requested);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.sqlite = new DatabaseSync(file);
    }
    this.sqlite.exec('PRAGMA journal_mode = WAL;');
    this.sqlite.exec('PRAGMA foreign_keys = ON;');
    this.sqlite.exec(CREATE_SQL);
    this.ensureWalletRow();
  }

  get raw(): DatabaseSync {
    return this.sqlite;
  }

  /** snake_case → camelCase 键映射（node:sqlite 原样返回列名，TS 行接口统一 camelCase） */
  private static mapKeys(row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = v;
    }
    return out;
  }

  /** 便捷：运行一条预编译查询返回全部行（键已映射 camelCase） */
  all<T>(sql: string, ...params: (string | number | null)[]): T[] {
    const rows = this.sqlite.prepare(sql).all(...params) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => DbService.mapKeys(r)) as unknown as T[];
  }

  get<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
    const row = this.sqlite.prepare(sql).get(...params) as unknown as Record<string, unknown> | undefined;
    return row ? (DbService.mapKeys(row) as unknown as T) : undefined;
  }

  run(sql: string, ...params: (string | number | null)[]): { changes: number | bigint } {
    return this.sqlite.prepare(sql).run(...params);
  }

  private ensureWalletRow() {
    const row = this.sqlite.prepare('SELECT id FROM wallet WHERE id = 1').get();
    if (!row) {
      this.sqlite
        .prepare(
          'INSERT INTO wallet (id, cash_usd, peak_equity, day_anchor_equity, day_key, updated_at) VALUES (1, ?, ?, ?, ?, ?)',
        )
        .run(
          this.config.bankrollUsd as unknown as number,
          this.config.bankrollUsd as unknown as number,
          this.config.bankrollUsd as unknown as number,
          nowIso().slice(0, 10),
          nowIso(),
        );
    }
  }
}
