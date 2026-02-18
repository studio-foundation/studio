import { describe, it } from 'vitest';

describe.skip('status command', () => {
  it('should display latest run when no run-id given', async () => {
    // TODO: Mock SQLiteRunStore, verify getLatestRun() is called
  });

  it('should display specific run when run-id given', async () => {
    // TODO: Mock SQLiteRunStore, verify getPipelineRun(id) is called
  });

  it('should show "No runs found" when store is empty', async () => {
    // TODO: Mock empty store, verify output
  });
});
