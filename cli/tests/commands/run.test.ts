import { describe, it } from 'vitest';

describe.skip('run command', () => {
  it('should call engine.run with correct params', async () => {
    // TODO: Mock PipelineEngine, verify that run() is called with the right args
  });

  it('should exit 0 on success', async () => {
    // TODO: Mock engine returning success, verify process.exit(0)
  });

  it('should exit 1 on failure', async () => {
    // TODO: Mock engine returning failed, verify process.exit(1)
  });

  it('should require --input flag', async () => {
    // TODO: Call without input, verify error message
  });
});
