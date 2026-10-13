import { useCallback, useEffect, useState } from 'react';
import { accentForeground, accentOnSurface, DEFAULT_APPEARANCE, PALETTES, paletteScheme, resolveTheme, SURFACES } from '@shared/theme';
import type { AppearanceSettings, ThemePalette } from '@shared/types';

const media = window.matchMedia('(prefers-color-scheme: dark)');

/** Loads persisted appearance from main, applies the palette to <html>, follows Windows in System mode. */
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

  const palette: ThemePalette = resolveTheme(settings, systemDark);
  const scheme = paletteScheme(palette);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = palette;
    root.dataset.scheme = scheme;
    root.style.colorScheme = scheme;
    for (const [k, v] of Object.entries(PALETTES[palette])) root.style.setProperty(`--${k}`, v);
    root.style.setProperty('--accent', settings.accent);
    root.style.setProperty('--accent-fg', accentForeground(settings.accent));
    root.style.setProperty('--accent-text', accentOnSurface(settings.accent, SURFACES[palette], scheme));
  }, [palette, scheme, settings.accent]);

  const update = useCallback(async (patch: Partial<AppearanceSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    setSettings(await window.studio.setAppearance(next));
  }, [settings]);

  /** `resolved` is the light/dark scheme (for components like the node editor); `palette` the exact look. */
  return { settings, resolved: scheme, palette, loaded, update };
}
