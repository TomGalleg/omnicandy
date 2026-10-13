import { useCallback, useEffect, useState } from 'react';
import { accentForeground, accentOnSurface, DEFAULT_APPEARANCE, resolveTheme, SURFACES } from '@shared/theme';
import type { AppearanceSettings } from '@shared/types';

const media = window.matchMedia('(prefers-color-scheme: dark)');

/** Loads persisted appearance from main, applies tokens to <html>, follows Windows in System mode. */
export function useAppearance() {
  const [settings, setSettings] = useState<AppearanceSettings>(DEFAULT_APPEARANCE);
  const [systemDark, setSystemDark] = useState(media.matches);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void window.studio.getAppearance().then((s) => { setSettings(s); setLoaded(true); });
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const resolved = resolveTheme(settings.mode, systemDark);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.style.setProperty('--accent', settings.accent);
    root.style.setProperty('--accent-fg', accentForeground(settings.accent));
    root.style.setProperty('--accent-text', accentOnSurface(settings.accent, SURFACES[resolved], resolved));
  }, [resolved, settings.accent]);

  const update = useCallback(async (patch: Partial<AppearanceSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    setSettings(await window.studio.setAppearance(next));
  }, [settings]);

  return { settings, resolved, loaded, update };
}
