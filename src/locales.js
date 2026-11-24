export const DEFAULT_LOCALE = 'zh_cn';
export const ENGLISH_LOCALE = 'en_us';
export const LOCALE_KEY = 'buildermcp.language';

export function normalizeLocale(code) {
  const name = typeof code === 'string' ? code.toLowerCase().replaceAll('-', '_') : '';
  return /^[a-z]{2,8}(?:_[a-z0-9]{2,8}){0,2}$/.test(name) ? name : null;
}

export function localeName(locale) {
  switch (locale) {
    case DEFAULT_LOCALE: return '简体中文';
    case ENGLISH_LOCALE: return 'English (US)';
    case 'zh_tw': return '繁體中文（台灣）';
    case 'zh_hk': return '繁體中文（香港）';
    default: {
      const tag = locale.replaceAll('_', '-');
      try { return new Intl.DisplayNames([tag], { type: 'language', fallback: 'none' }).of(tag) ?? locale; }
      catch { return locale; }
    }
  }
}
