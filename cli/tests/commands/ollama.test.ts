import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock child_process before importing the module
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn() };
});

const { spawnSync } = await import('node:child_process');
const { ollamaStatusCommand, ollamaStartCommand, ollamaStopCommand, ollamaPullCommand } = await import('../../src/commands/ollama.js');

afterEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', undefined);
});

describe('ollamaStatusCommand', () => {
  it('prints running + models when Ollama responds', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'llama3.3:latest', size: 4_200_000_000 },
          { name: 'codellama:7b', size: 3_800_000_000 },
        ],
      }),
    }) as unknown as typeof fetch;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await ollamaStatusCommand('http://localhost:11434');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('running'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('llama3.3:latest'));
    logSpy.mockRestore();
  });

  it('prints not running when fetch fails', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await ollamaStatusCommand('http://localhost:11434');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('not running'));
    logSpy.mockRestore();
  });
});

describe('ollamaStartCommand', () => {
  it('prints "already running" when Ollama is reachable', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [] }),
    }) as unknown as typeof fetch;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await ollamaStartCommand('http://localhost:11434');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
    logSpy.mockRestore();
  });

  it('prints native ollama serve command when ollama is installed', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await ollamaStartCommand('http://localhost:11434');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ollama serve'));
    logSpy.mockRestore();
  });

  it('prints docker run command when only docker is available', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 1 } as ReturnType<typeof spawnSync>) // ollama not found
      .mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>); // docker found

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await ollamaStartCommand('http://localhost:11434');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('docker run'));
    logSpy.mockRestore();
  });

  it('prints install instructions when neither is available', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    vi.mocked(spawnSync).mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await ollamaStartCommand('http://localhost:11434');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('docker.com'));
    logSpy.mockRestore();
  });
});

describe('ollamaStopCommand', () => {
  it('always prints stop instructions including docker stop', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await ollamaStopCommand();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('docker stop'));
    logSpy.mockRestore();
  });
});

describe('ollamaPullCommand', () => {
  it('exits with error when Ollama not running', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as (code?: number) => never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await ollamaPullCommand('llama3.3', 'http://localhost:11434');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('streams pull and prints success', async () => {
    const encoder = new TextEncoder();
    const ndjson = '{"status":"pulling manifest"}\n{"status":"success"}\n';

    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, json: async () => ({ models: [] }) };
      }
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(ndjson));
          controller.close();
        },
      });
      return { ok: true, body: stream };
    }) as unknown as typeof fetch;

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await ollamaPullCommand('llama3.3', 'http://localhost:11434');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Pulled llama3.3'));
    writeSpy.mockRestore();
    logSpy.mockRestore();
  });
});
