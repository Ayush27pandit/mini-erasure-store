import { createHash } from 'crypto';

export class HashService {
  compute(buffer: Uint8Array): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  verify(buffer: Uint8Array, expected: string): boolean {
    return this.compute(buffer) === expected;
  }
}

export const hashService = new HashService();
