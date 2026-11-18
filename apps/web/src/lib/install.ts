import { useSyncExternalStore } from 'react';

/**
 * The installable app: registers the service worker (production builds) and keeps the browser's install prompt
 * (Chrome, Edge, Android) so a button can show it later. iPhone/iPad have no prompt: people use Share → Add to Home Screen.
 */
interface InstallPrompt extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
let deferred: InstallPrompt | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setUpInstall() {
  if (typeof window === 'undefined') return;
  installed = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as InstallPrompt; emit(); });
  window.addEventListener('appinstalled', () => { deferred = null; installed = true; emit(); });
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* not available (e.g. private mode): the app works without */ }); });
  }
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
type State = { canPrompt: boolean; installed: boolean; ios: boolean };
let snapshot: State = { canPrompt: false, installed: false, ios: false };
function read(): State {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const next = { canPrompt: !!deferred, installed, ios };
  if (next.canPrompt !== snapshot.canPrompt || next.installed !== snapshot.installed || next.ios !== snapshot.ios) snapshot = next;
  return snapshot;
}
export const useInstall = () => useSyncExternalStore(subscribe, read, () => snapshot);

/** Shows the browser's install dialog. Returns true when the person installed it. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const p = deferred;
  deferred = null;
  emit();
  await p.prompt();
  return (await p.userChoice).outcome === 'accepted';
}
