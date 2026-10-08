import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('locale preference', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('defaults to English and restores a selected language after reload', async () => {
    const locale = await import('./locale');
    expect(locale.getLocale()).toBe('en');
    const listener = vi.fn();
    const unsubscribe = locale.subscribeLocale(listener);
    locale.setLocale('ko');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(locale.LOCALE_STORAGE_KEY)).toBe('ko');
    unsubscribe();
    locale.setLocale('en');
    expect(listener).toHaveBeenCalledTimes(1);
    locale.setLocale('ko');
    vi.resetModules();
    expect((await import('./locale')).getLocale()).toBe('ko');
  });

  it('keeps switching when storage reads or writes fail', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('unavailable'); });
    const locale = await import('./locale');
    expect(locale.getLocale()).toBe('en');
    const listener = vi.fn();
    locale.subscribeLocale(listener);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
    expect(() => locale.setLocale('ko')).not.toThrow();
    expect(locale.getLocale()).toBe('ko');
    expect(listener).toHaveBeenCalledOnce();
  });
});
