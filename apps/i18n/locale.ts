export type Locale = 'en' | 'ko';

export const LOCALE_STORAGE_KEY = 'browser-error-log.language';

const listeners = new Set<() => void>();

function storedLocale(): Locale {
  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY) === 'ko' ? 'ko' : 'en';
  } catch {
    return 'en';
  }
}

let locale: Locale = storedLocale();

export function getLocale(): Locale {
  return locale;
}

export function setLocale(next: Locale): void {
  if (next === locale) return;
  locale = next;
  try { window.localStorage.setItem(LOCALE_STORAGE_KEY, next); } catch { /* Persistence is optional. */ }
  listeners.forEach(listener => listener());
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key !== LOCALE_STORAGE_KEY) return;
    const next = storedLocale();
    if (next === locale) return;
    locale = next;
    listeners.forEach(listener => listener());
  });
}
