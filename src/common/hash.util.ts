import { createHash, randomUUID } from 'node:crypto';

export const sha256 = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');

export const newRequestId = (): string => randomUUID();

export const nowIso = (): string => new Date().toISOString();
