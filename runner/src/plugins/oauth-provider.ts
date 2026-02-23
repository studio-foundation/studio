import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { exec } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

interface StorageData {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
}

function urlHash(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

export class StudioOAuthProvider implements OAuthClientProvider {
  private readonly filePath: string;
  private _codeVerifier: string | undefined;
  private _callbackPort: number | undefined;

  constructor(
    private readonly serverUrl: string,
    private readonly storageDir: string = join(
      process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
      '.config', 'studio', 'oauth'
    ),
    private readonly timeoutMs: number = 5 * 60 * 1000
  ) {
    this.filePath = join(storageDir, `${urlHash(serverUrl)}.json`);
  }

  // --- Storage helpers ---

  private async load(): Promise<StorageData> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      return JSON.parse(raw) as StorageData;
    } catch {
      return {};
    }
  }

  private async save(data: StorageData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  // --- OAuthClientProvider: tokens ---

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.load()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const data = await this.load();
    await this.save({ ...data, tokens });
  }

  // --- OAuthClientProvider: client information ---

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.load()).clientInformation;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    const data = await this.load();
    await this.save({ ...data, clientInformation: info });
  }

  // --- OAuthClientProvider: PKCE ---

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (this._codeVerifier === undefined) {
      throw new Error('No code verifier saved for this session');
    }
    return this._codeVerifier;
  }

  // --- OAuthClientProvider: metadata ---

  get redirectUrl(): string | undefined {
    if (this._callbackPort === undefined) return undefined;
    return `http://localhost:${this._callbackPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    const redirectUri = this.redirectUrl ?? 'http://localhost/callback';
    return {
      client_name: 'Studio',
      redirect_uris: [new URL(redirectUri)],
    };
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    const url = authorizationUrl.toString();
    process.stderr.write(`\n  Open this URL to authorize Studio:\n  ${url}\n\n`);

    const cmd =
      process.platform === 'darwin' ? `open "${url}"` :
      process.platform === 'win32' ? `start "" "${url}"` :
      `xdg-open "${url}"`;

    exec(cmd, () => { /* ignore errors — URL already printed */ });
  }

  // --- Callback server ---

  async startCallbackServer(): Promise<{ codePromise: Promise<string>; close: () => void }> {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Authorization successful</h1><p>You can close this tab.</p></body></html>');
          resolveCode(code);
        } else {
          res.writeHead(400);
          res.end('Missing code parameter');
          rejectCode(new Error('OAuth callback missing code parameter'));
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((res, rej) => {
      server.listen(0, 'localhost', res);
      server.on('error', rej);
    });

    const { port } = server.address() as AddressInfo;
    this._callbackPort = port;

    const timeout = setTimeout(() => {
      rejectCode(new Error('OAuth authorization timed out. Run again to retry.'));
      server.close();
      this._callbackPort = undefined;
    }, this.timeoutMs);

    const close = () => {
      clearTimeout(timeout);
      server.close();
      this._callbackPort = undefined;
    };

    return { codePromise, close };
  }
}
