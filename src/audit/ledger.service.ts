import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { LedgerRow } from '../db/schema';
import { nowIso, sha256 } from '../common/hash.util';

export interface VerifyResult {
  ok: boolean;
  total: number;
  brokenAtId: number | null;
}

/**
 * 决策账本：SHA-256 hash 链（entry.hash = sha256(prev_hash + ts + kind + payload)）。
 * 任何历史记录被篡改即 verify() 失败 —— 审计的底线。
 */
@Injectable()
export class LedgerService {
  constructor(private db: DbService) {}

  append(kind: string, payload: unknown, ref?: string): LedgerRow {
    const payloadJson = JSON.stringify(payload);
    const prev = this.db.get<{ hash: string }>(
      'SELECT hash FROM ledger ORDER BY id DESC LIMIT 1',
    );
    const prevHash = prev?.hash ?? 'GENESIS';
    const ts = nowIso();
    const hash = sha256(`${prevHash}|${ts}|${kind}|${payloadJson}`);
    this.db.run(
      'INSERT INTO ledger (ts, kind, ref, payload_json, prev_hash, hash) VALUES (?,?,?,?,?,?)',
      ts, kind, ref ?? null, payloadJson, prevHash, hash,
    );
    const row = this.db.get<LedgerRow>('SELECT * FROM ledger ORDER BY id DESC LIMIT 1');
    if (!row) throw new Error('ledger 写入失败');
    return row;
  }

  verify(): VerifyResult {
    const rows = this.db.all<LedgerRow>('SELECT * FROM ledger ORDER BY id');
    let prevHash = 'GENESIS';
    for (const r of rows) {
      const expect = sha256(`${prevHash}|${r.ts}|${r.kind}|${r.payloadJson}`);
      if (r.prevHash !== prevHash || r.hash !== expect) {
        return { ok: false, total: rows.length, brokenAtId: r.id };
      }
      prevHash = r.hash;
    }
    return { ok: true, total: rows.length, brokenAtId: null };
  }

  recent(limit = 50): LedgerRow[] {
    return this.db.all<LedgerRow>('SELECT * FROM ledger ORDER BY id DESC LIMIT ?', limit);
  }
}
