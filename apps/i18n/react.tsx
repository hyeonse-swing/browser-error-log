import { useSyncExternalStore } from 'react';
import { getLocale, setLocale, subscribeLocale, type Locale } from './locale';

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, () => 'en');
}

export function LanguageSwitcher() {
  const locale = useLocale();
  return <label className="language-switcher">
    <span>{locale === 'ko' ? '언어' : 'Language'}</span>
    <select aria-label={locale === 'ko' ? '언어 선택' : 'Choose language'} value={locale} onChange={event => setLocale(event.target.value as Locale)}>
      <option value="en">English</option>
      <option value="ko">한국어</option>
    </select>
  </label>;
}
