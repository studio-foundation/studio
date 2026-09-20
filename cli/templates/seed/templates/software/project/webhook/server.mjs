// Minimal inbound webhook: verify an HMAC signature, map one payload field to
// `--input`, run `studio run`. Studio serves no webhook itself, so this is the
// project's job. Provider concerns (subscription renewal, health checks,
// alerting) are out of scope.
//
//   WEBHOOK_SECRET=... WEBHOOK_PIPELINE=<pipeline> node webhook/server.mjs
//
// WEBHOOK_SECRET            shared secret (required)
// WEBHOOK_PIPELINE          pipeline to run (required, no default)
// WEBHOOK_INPUT_FIELD       dot path in the JSON payload used as --input (default: the whole payload)
// WEBHOOK_SIGNATURE_HEADER  header carrying the hex sha256 HMAC, optional "sha256=" prefix (default: x-hub-signature-256)
// PORT                      default 8787

import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';

const { WEBHOOK_SECRET, WEBHOOK_PIPELINE, WEBHOOK_INPUT_FIELD } = process.env;
const header = (process.env.WEBHOOK_SIGNATURE_HEADER ?? 'x-hub-signature-256').toLowerCase();
const port = Number(process.env.PORT ?? 8787);

if (!WEBHOOK_SECRET) throw new Error('WEBHOOK_SECRET is not set');
if (!WEBHOOK_PIPELINE) throw new Error('WEBHOOK_PIPELINE is not set');

function validSignature(body, received = '') {
  const expected = createHmac('sha256', WEBHOOK_SECRET).update(body).digest();
  const given = Buffer.from(received.replace(/^sha256=/, ''), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function pick(payload, path) {
  return path.split('.').reduce((value, key) => value?.[key], payload);
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (!validSignature(body, req.headers[header])) {
      res.writeHead(401).end();
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      res.writeHead(400).end();
      return;
    }

    const value = WEBHOOK_INPUT_FIELD ? pick(payload, WEBHOOK_INPUT_FIELD) : payload;
    if (value === undefined) {
      res.writeHead(422).end();
      return;
    }
    const input = typeof value === 'string' ? value : JSON.stringify(value);

    // Arguments, never a shell string: the payload is untrusted.
    execFile('studio', ['run', WEBHOOK_PIPELINE, '--input', input], (error) => {
      if (error) console.error(`studio run failed: ${error.message}`);
    });
    res.writeHead(202).end();
  });
}).listen(port, () => console.log(`webhook listening on :${port}`));
