// Which ArtCraft apps CreateCraft can switch between dark and light, and how. Every "auto" entry
// was verified live through the app's own official control (docs/integration-audit.md); nothing
// here edits app config files or recolours windows.

import type { ThemePalette } from './types';

export type ThemeSyncSupport = 'auto' | 'later' | 'manual';

export interface AppThemeInfo {
  id: string;
  name: string;
  support: ThemeSyncSupport;
  /** Plain-language note shown in the Appearance menu. */
  note: string;
}

export const APP_THEME_SUPPORT: AppThemeInfo[] = [
  { id: 'photocraft', name: 'PhotoCraft', support: 'auto', note: 'Matched automatically' },
  { id: 'vectorcraft', name: 'VectorCraft', support: 'auto', note: 'Matched automatically' },
  { id: 'soundcraft', name: 'SoundCraft', support: 'auto', note: 'Matched automatically (dark or light)' },
  { id: 'filmcraft', name: 'FilmCraft', support: 'auto', note: 'Matched automatically' },
  { id: 'lightcraft', name: 'LightCraft', support: 'auto', note: 'Matched automatically (dark or light)' },
  { id: 'effectcraft', name: 'EffectCraft', support: 'auto', note: 'Matched automatically (dark or light)' },
  { id: 'designcraft', name: 'DesignCraft', support: 'auto', note: 'Matched automatically' },
  { id: 'gridcraft', name: 'GridCraft', support: 'manual', note: 'Keeps its own look (no verified theme setting)' },
  { id: 'deckcraft', name: 'DeckCraft', support: 'manual', note: 'Keeps its own look (no verified theme setting)' },
  { id: 'pdfcraft', name: 'PdfCraft', support: 'manual', note: 'Keeps its own look (its control port has no theme setting)' },
  { id: 'wordcraft', name: 'WordCraft', support: 'manual', note: 'Keeps its own look (no verified theme setting)' },
];

/** The app's own theme value for a CreateCraft palette. */
export function appThemeValue(appId: string, palette: ThemePalette): string | null {
  switch (appId) {
    // PhotoCraft built-in themes: proMedium is its charcoal default (what ArtCraft Match is measured from).
    case 'photocraft': return palette === 'light' ? 'studioLight' : palette === 'studioDark' ? 'pro' : 'proMedium';
    case 'vectorcraft': return palette === 'light' ? 'light' : palette === 'studioDark' ? 'dark' : 'mediumDark';
    case 'soundcraft': return palette === 'light' ? 'light' : 'dark';
    // FilmCraft prefs appearance.colorTheme: darkest | dark | light.
    case 'filmcraft': return palette === 'light' ? 'light' : palette === 'studioDark' ? 'darkest' : 'dark';
    // LightCraft settings.appearanceMode and EffectCraft appearance.appearanceMode: dark | light.
    case 'lightcraft': case 'effectcraft': return palette === 'light' ? 'light' : 'dark';
    // DesignCraft ui brightness: dark | mediumDark | mediumLight | light.
    case 'designcraft': return palette === 'light' ? 'light' : palette === 'studioDark' ? 'dark' : 'mediumDark';
    default: return null;
  }
}
