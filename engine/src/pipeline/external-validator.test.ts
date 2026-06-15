import { describe, it, expect } from 'vitest';
import { runExternalValidators } from './external-validator.js';
import type { ExternalValidator } from '@studio-foundation/contracts';

// A validator (run via node, always available in the test env) that reads the
// output JSON from stdin and approves only when bucket === 'A'.
const approveOnlyA: ExternalValidator = {
  name: 'only-a',
  command:
    `node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{` +
    `const o=JSON.parse(s);const ok=o.bucket==='A';` +
    `process.stdout.write(JSON.stringify({valid:ok,errors:ok?[]:['bucket must be A']}));` +
    `process.exit(ok?0:1)})"`,
};

describe('runExternalValidators', () => {
  it('is valid when there are no validators', async () => {
    const res = await runExternalValidators({ bucket: 'B' }, [], process.cwd());
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it('passes the output JSON on stdin and accepts a valid output', async () => {
    const res = await runExternalValidators({ bucket: 'A' }, [approveOnlyA], process.cwd());
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it('reports the validator errors when the output is rejected', async () => {
    const res = await runExternalValidators({ bucket: 'B' }, [approveOnlyA], process.cwd());
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('bucket must be A');
  });

  it('fails closed when the command output is not parseable JSON', async () => {
    const bad: ExternalValidator = { name: 'bad', command: "echo 'not json'" };
    const res = await runExternalValidators({ bucket: 'A' }, [bad], process.cwd());
    expect(res.valid).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
  });

  it('aggregates errors across multiple validators', async () => {
    const res = await runExternalValidators(
      { bucket: 'B' },
      [approveOnlyA, approveOnlyA],
      process.cwd()
    );
    expect(res.valid).toBe(false);
    expect(res.errors.filter((e) => e === 'bucket must be A')).toHaveLength(2);
  });
});
