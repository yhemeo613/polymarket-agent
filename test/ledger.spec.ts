import { LedgerService } from '../src/audit/ledger.service';
import { makeStack } from './helpers';
import * as fs from 'node:fs';

describe('ledger hash 链不变量（M16）', () => {
  afterEach(() => {
    try { fs.rmSync('./data/test-kill.switch', { force: true }); } catch { /* 忽略 */ }
  });

  it('连续追加形成链式哈希，verify 通过', () => {
    const { db } = makeStack();
    const ledger = new LedgerService(db);
    ledger.append('a', { x: 1 });
    ledger.append('b', { y: 2 });
    ledger.append('c', { z: 3 });
    const v = ledger.verify();
    expect(v.ok).toBe(true);
    expect(v.total).toBe(3);
  });

  it('篡改任一条历史 → verify 失败并定位', () => {
    const { db } = makeStack();
    const ledger = new LedgerService(db);
    ledger.append('a', { x: 1 });
    ledger.append('b', { y: 2 });
    db.run("UPDATE ledger SET payload_json = '{\"y\":999}' WHERE kind = 'a'");
    const v = ledger.verify();
    expect(v.ok).toBe(false);
    expect(v.brokenAtId).toBe(1);
  });
});
