# Design: OAuth Flow for HTTP MCP Servers (STU-124)

## Context

HTTP MCP transport with static Bearer tokens works (STU-122). Linear MCP
(`https://mcp.linear.app/mcp`) uses interactive OAuth — no static token.
The SDK's `StreamableHTTPClientTransport` accepts an `authProvider:
OAuthClientProvider` option that handles the full OAuth dance, including
token refresh. We need to implement that provider and wire it into
`MCPClient`.

## Approach

OAuth is fully encapsulated inside `MCPClient`. The CLI (`run.ts`) requires
no changes. On first run the user sees a browser open and a "Authorization
successful" page; on subsequent runs the stored tokens are used silently.

## Components

### New file: `runner/src/plugins/oauth-provider.ts`

Implements `OAuthClientProvider` from
`@modelcontextprotocol/sdk/client/auth.js`.

| Method | Behaviour |
|---|---|
| `tokens()` / `saveTokens()` | Read/write `~/.config/studio/oauth/<urlhash>.json` |
| `clientInformation()` / `saveClientInformation()` | Same file — supports dynamic client registration (RFC 7591) |
| `codeVerifier()` / `saveCodeVerifier()` | In-memory per auth session, not persisted |
| `redirectToAuthorization(url)` | Opens browser via `xdg-open`/`open`/`start`; always prints URL to stderr as fallback |
| `redirectUrl` getter | `http://localhost:PORT/callback` — PORT chosen dynamically when server starts |
| `clientMetadata` getter | `{ client_name: 'Studio', redirect_uris: [redirectUrl] }` |
| `startCallbackServer()` | Starts Node HTTP server; returns `{ codePromise, close }` |

`startCallbackServer()`:
- Finds an available port (scan from 3742)
- GET `/callback?code=X` resolves `codePromise` with `X`, serves
  "Authorization successful, you can close this tab.", closes server
- `codePromise` rejects after 5 minutes: `"OAuth authorization timed out.
  Run again to retry."`

Token storage path: `~/.config/studio/oauth/<base64url(serverUrl)>.json`
```json
{
  "clientInformation": { "client_id": "...", "client_secret": "..." },
  "tokens": { "access_token": "...", "refresh_token": "...", "expires_in": 3600 }
}
```
Global (not per-project) so the user authenticates once across all projects.

### Modified: `runner/src/plugins/plugin-loader.ts`

Add optional `auth` field to the HTTP variant of `MCPServerDef`:

```typescript
| {
    type: 'http';
    url: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
    auth?: {
      type: 'oauth';
      client_id?: string;
      client_secret?: string;
      scope?: string;
    };
  }
```

### Modified: `runner/src/plugins/mcp-client.ts`

Constructor: when `def.type === 'http'` and `def.auth?.type === 'oauth'`,
instantiate `StudioOAuthProvider` and pass it as `authProvider` to
`StreamableHTTPClientTransport`. Otherwise use existing static-headers path.

`start()` new flow when `oauthProvider` is set:

```
1. provider.startCallbackServer() → { codePromise, close }
2. try client.connect(transport)
   → success: close server, done (tokens already existed / refresh succeeded)
   → UnauthorizedError:
       browser already opened inside redirectToAuthorization()
       code = await codePromise  (5 min timeout)
       close()
       await transport.finishAuth(code)
       await client.connect(transport)  ← retry
```

## Config (`.mcp.json`)

```json
{
  "mcpServers": {
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp",
      "auth": {
        "type": "oauth",
        "scope": "read:issues write:issues"
      }
    }
  }
}
```

`client_id` and `client_secret` are optional. When absent, the SDK uses
dynamic client registration to obtain them automatically. Linear supports
this, so no credentials are needed in the file.

## Error Handling

| Scenario | Behaviour |
|---|---|
| Browser open fails | URL still printed to stderr; user opens manually |
| Callback timeout (5 min) | `codePromise` rejects with clear message |
| `finishAuth` or retry `connect` fails | Thrown, surfaced as existing CLI warning |
| Token refresh (access expired, refresh valid) | Handled transparently by SDK before `UnauthorizedError` is thrown |
| Session expiry mid-run (tool call) | Tool call returns error; no mid-run re-auth (out of scope) |

## Testing

**`oauth-provider.test.ts`** (new):
- `tokens()` returns `undefined` when no storage file exists
- `saveTokens()` + `tokens()` round-trip
- `saveClientInformation()` + `clientInformation()` round-trip
- `codeVerifier` is in-memory — save then load returns same value
- `startCallbackServer()` — GET `/callback?code=abc` resolves `codePromise`
  with `'abc'`
- Timeout — short timeout override causes `codePromise` to reject
- `redirectUrl` matches `http://localhost:PORT/callback`

**`mcp-client.test.ts`** additions:
- Constructing with `auth: { type: 'oauth' }` exposes an `oauthProvider`
- Constructing without `auth` leaves `oauthProvider` undefined

Full OAuth round-trip tested manually against `https://mcp.linear.app/mcp`.
