export type Theme = 'light' | 'dark' | 'system';
export const getTheme = (): Theme => {
  try { return (localStorage.getItem('crm-theme') as Theme) || 'system'; } catch { return 'system'; }
};
export function applyTheme(t: Theme) {
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try { localStorage.setItem('crm-theme', t); } catch { /* ignore */ }
}
