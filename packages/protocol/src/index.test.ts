import { describe, expect, it } from 'vitest';
import { BREADCRUMB_LIMITS, isBreadcrumbTrail, type Breadcrumb } from './index';

const entry = (): Breadcrumb => ({
  occurredAt: '2026-11-02T00:00:00.000Z', category: 'navigation', message: 'Checkout opened',
  data: { route: 'checkout', count: 2, ready: true, optional: null },
});

describe('breadcrumb wire contract', () => {
  it('accepts bounded scalar entries and an empty trail without changing the input', () => {
    const trail = [entry()];
    const before = JSON.stringify(trail);
    expect(isBreadcrumbTrail(trail)).toBe(true);
    expect(isBreadcrumbTrail([])).toBe(true);
    expect(JSON.stringify(trail)).toBe(before);
    expect(isBreadcrumbTrail(Array.from({ length: BREADCRUMB_LIMITS.count }, entry))).toBe(true);
  });

  it.each([
    undefined, null, {}, [null],
    [{ ...entry(), occurredAt: '2026-11-02' }],
    [{ ...entry(), occurredAt: '2026-02-30T00:00:00.000Z' }],
    [{ ...entry(), occurredAt: '2026-11-02T09:00:00.000+09:00' }],
    [{ ...entry(), category: '' }],
    [{ ...entry(), category: 'x'.repeat(BREADCRUMB_LIMITS.category + 1) }],
    [{ ...entry(), message: ' ' }],
    [{ ...entry(), message: 'x'.repeat(BREADCRUMB_LIMITS.message + 1) }],
    [{ ...entry(), secret: 'unexpected field' }],
    [{ ...entry(), data: { nested: { unsafe: true } } }],
    [{ ...entry(), data: { count: Infinity } }],
    [{ ...entry(), data: [] }],
    [{ ...entry(), data: { ['x'.repeat(BREADCRUMB_LIMITS.dataKey + 1)]: true } }],
    [{ ...entry(), data: { text: 'x'.repeat(BREADCRUMB_LIMITS.dataString + 1) } }],
    [{ ...entry(), data: Object.fromEntries(Array.from({ length: BREADCRUMB_LIMITS.dataKeys + 1 }, (_, i) => [`key${i}`, i])) }],
    Array.from({ length: BREADCRUMB_LIMITS.count + 1 }, entry),
  ].map(value => ({ value })))('rejects malformed or oversized trail %#', ({ value }) => {
    expect(isBreadcrumbTrail(value)).toBe(false);
  });

  it('bounds UTF-8 bytes independently of entry count and string character limits', () => {
    const trail = Array.from({ length: BREADCRUMB_LIMITS.count }, () => ({
      ...entry(), message: '한'.repeat(BREADCRUMB_LIMITS.message),
    }));
    expect(new TextEncoder().encode(JSON.stringify(trail)).length).toBeGreaterThan(BREADCRUMB_LIMITS.bytes);
    expect(isBreadcrumbTrail(trail)).toBe(false);
  });

  it('rejects hostile values without throwing', () => {
    const hostile = new Proxy({}, { ownKeys() { throw new Error('unavailable'); } });
    expect(isBreadcrumbTrail([hostile])).toBe(false);
    const getter = { ...entry(), get message(): never { throw new Error('unavailable'); } };
    expect(isBreadcrumbTrail([getter])).toBe(false);
  });
});
