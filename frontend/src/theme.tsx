import { Moon, Sun } from 'lucide-react';
import { useSyncExternalStore } from 'react';

type Theme = 'light' | 'dark';
const storageKey = 'kontur-theme';
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

function readPreference(): Theme | null {
  try {
    const value = localStorage.getItem(storageKey);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

let preference = readPreference();
let theme: Theme;

function applyTheme() {
  theme = preference ?? (systemTheme.matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#191a1e' : '#f5f7fa');
  listeners.forEach(listener => listener());
}

applyTheme();
systemTheme.addEventListener('change', applyTheme);
window.addEventListener('storage', event => {
  if (event.key !== storageKey && event.key !== null) return;
  preference = readPreference();
  applyTheme();
});

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function ThemeToggle() {
  const dark = useSyncExternalStore(subscribe, () => theme) === 'dark';
  const Icon = dark ? Sun : Moon;

  function toggle() {
    preference = dark ? 'light' : 'dark';
    try {
      localStorage.setItem(storageKey, preference);
    } catch {
      // The current tab can still switch themes when browser storage is blocked.
    }
    applyTheme();
  }

  return <button type="button" className="icon-button theme-toggle" aria-label="Тёмная тема" aria-pressed={dark}
    title={dark ? 'Включить светлую тему' : 'Включить тёмную тему'} onClick={toggle}><Icon size={17} aria-hidden="true" /></button>;
}
