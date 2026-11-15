import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark' | 'system';

const isDark = () => document.documentElement.dataset.theme === 'dark';
function subscribe(onChange: () => void) {
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => mo.disconnect();
}
/** True while the dark theme is applied; re-renders when the theme changes (for colours passed to charts as props). */
export const useIsDark = () => useSyncExternalStore(subscribe, isDark, () => false);
export const getTheme = (): Theme => {
  try { return (localStorage.getItem('crm-theme') as Theme) || 'system'; } catch { return 'system'; }
};
export function applyTheme(t: Theme) {
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try { localStorage.setItem('crm-theme', t); } catch { /* ignore */ }
}
