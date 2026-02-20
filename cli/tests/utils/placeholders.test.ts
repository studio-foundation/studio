import { describe, it, expect } from 'vitest';
import { applyPlaceholders } from '../../src/utils/placeholders.js';

describe('applyPlaceholders', () => {
  it('replaces a single known placeholder', () => {
    expect(applyPlaceholders('Hello {{PROJECT_NAME}}', { PROJECT_NAME: 'my-app' }))
      .toBe('Hello my-app');
  });

  it('replaces multiple placeholders in one pass', () => {
    const result = applyPlaceholders(
      'name: {{PROJECT_NAME}}\ntemplate: {{TEMPLATE_NAME}}\nyear: {{YEAR}}',
      { PROJECT_NAME: 'x', TEMPLATE_NAME: 'software', YEAR: '2026' }
    );
    expect(result).toBe('name: x\ntemplate: software\nyear: 2026');
  });

  it('replaces the same placeholder multiple times', () => {
    expect(applyPlaceholders('{{PROJECT_NAME}} / {{PROJECT_NAME}}', { PROJECT_NAME: 'app' }))
      .toBe('app / app');
  });

  it('throws on unresolved placeholder', () => {
    expect(() => applyPlaceholders('{{UNKNOWN}}', {}))
      .toThrow('Unresolved placeholder: {{UNKNOWN}}');
  });

  it('returns content unchanged when no placeholders', () => {
    expect(applyPlaceholders('no placeholders here', {})).toBe('no placeholders here');
  });

  it('does not replace lowercase or mixed-case patterns', () => {
    // Only {{ALL_CAPS_WITH_UNDERSCORES}} are treated as placeholders
    expect(applyPlaceholders('{{lowercase}}', {})).toBe('{{lowercase}}');
  });
});
