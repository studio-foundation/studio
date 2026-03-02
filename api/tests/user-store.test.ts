import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { UserStore, type User } from '../src/user-store.js';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'alice@example.com',
    plan: 'free',
    api_key: 'sk-test-abc123',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('UserStore', () => {
  let store: UserStore;

  beforeEach(() => {
    const dbDir = resolve('/tmp', `.studio-user-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dbDir, { recursive: true });
    store = new UserStore(resolve(dbDir, 'runs.db'));
  });

  afterEach(() => {
    store.close();
  });

  // CRUD
  test('saves and retrieves a user by id', () => {
    const user = makeUser();
    store.saveUser(user);
    expect(store.getUserById('user-1')).toEqual(user);
  });

  test('retrieves a user by api_key', () => {
    const user = makeUser();
    store.saveUser(user);
    expect(store.getUserByApiKey('sk-test-abc123')).toEqual(user);
  });

  test('returns null for unknown id', () => {
    expect(store.getUserById('nonexistent')).toBeNull();
  });

  test('returns null for unknown api_key', () => {
    expect(store.getUserByApiKey('sk-unknown')).toBeNull();
  });

  test('lists all users', () => {
    store.saveUser(makeUser({ id: 'u1', email: 'a@a.com', api_key: 'key-1' }));
    store.saveUser(makeUser({ id: 'u2', email: 'b@b.com', api_key: 'key-2' }));
    expect(store.listUsers()).toHaveLength(2);
  });

  test('deletes a user', () => {
    store.saveUser(makeUser());
    store.deleteUser('user-1');
    expect(store.getUserById('user-1')).toBeNull();
  });

  // Usage tracking
  test('getDailyUsage returns zeros for new entry', () => {
    const usage = store.getDailyUsage('user-1', '2026-01-01');
    expect(usage.runs_count).toBe(0);
    expect(usage.tokens_used).toBe(0);
  });

  test('incrementRuns increases runs_count by 1', () => {
    store.incrementRuns('user-1', '2026-01-01');
    store.incrementRuns('user-1', '2026-01-01');
    expect(store.getDailyUsage('user-1', '2026-01-01').runs_count).toBe(2);
  });

  test('incrementTokens increases tokens_used', () => {
    store.incrementTokens('user-1', '2026-01-01', 1000);
    store.incrementTokens('user-1', '2026-01-01', 500);
    expect(store.getDailyUsage('user-1', '2026-01-01').tokens_used).toBe(1500);
  });

  test('usage is scoped by date — different dates are independent', () => {
    store.incrementRuns('user-1', '2026-01-01');
    store.incrementRuns('user-1', '2026-01-02');
    expect(store.getDailyUsage('user-1', '2026-01-01').runs_count).toBe(1);
    expect(store.getDailyUsage('user-1', '2026-01-02').runs_count).toBe(1);
  });

  test('usage is scoped by user — different users are independent', () => {
    store.incrementRuns('user-1', '2026-01-01');
    expect(store.getDailyUsage('user-2', '2026-01-01').runs_count).toBe(0);
  });
});
