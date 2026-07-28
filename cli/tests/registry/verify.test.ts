import { describe, it, expect } from 'vitest';
import { verifyPayload } from '../../src/registry/verify.js';

const MIT = 'MIT License\n\nPermission is hereby granted, free of charge, to any person…\n';
const AGPL = 'GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007\n';

const PAYLOAD = [
  { path: 'LICENSE', content: MIT },
  { path: 'metadata.json', content: '{}' },
  { path: 'deploy.tool.yaml', content: 'name: deploy\n' },
];

const ENTRY = { name: 'deploy', license: 'MIT', provides: { tools: ['deploy'] } };

describe('verifyPayload', () => {
  it('passes when the LICENSE and provides match the entry', () => {
    expect(verifyPayload(PAYLOAD, ENTRY)).toEqual([]);
  });

  it('rejects a payload with no LICENSE file', () => {
    const files = PAYLOAD.filter(f => f.path !== 'LICENSE');
    expect(verifyPayload(files, ENTRY)).toEqual(["declares license 'MIT' but ships no LICENSE file"]);
  });

  it('rejects a LICENSE that is not the declared one', () => {
    expect(verifyPayload(PAYLOAD, { ...ENTRY, license: 'AGPL-3.0' }))
      .toEqual(["ships a LICENSE file that is not 'AGPL-3.0'"]);
  });

  it('accepts a GPL-family suffix on the declared id', () => {
    const files = [{ path: 'LICENSE.md', content: AGPL }, ...PAYLOAD.slice(1)];
    expect(verifyPayload(files, { ...ENTRY, license: 'AGPL-3.0-or-later' })).toEqual([]);
  });

  it('accepts an unknown license id on presence alone', () => {
    expect(verifyPayload(PAYLOAD, { ...ENTRY, license: 'LicenseRef-Internal' })).toEqual([]);
  });

  it('rejects a declared item the payload does not ship', () => {
    expect(verifyPayload(PAYLOAD, { ...ENTRY, provides: { tools: ['deploy'], agents: ['coder'] } }))
      .toEqual(["declares agents 'coder', absent from the payload"]);
  });

  it('rejects content the payload ships without declaring', () => {
    const files = [...PAYLOAD, { path: 'exfiltrate.tool.yaml', content: 'name: x\n' }];
    expect(verifyPayload(files, ENTRY)).toEqual(["ships undeclared tool 'exfiltrate'"]);
  });

  it('ignores provides entirely when the entry declares none', () => {
    expect(verifyPayload(PAYLOAD, { name: 'deploy', license: 'MIT' })).toEqual([]);
  });
});
