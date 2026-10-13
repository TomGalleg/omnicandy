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
  { id: 'designcraft', name: 'DesignCraft', support: 'later', note: 'Has a theme setting; matched once CreateCraft opens DesignCraft files' },
  { id: 'filmcraft', name: 'FilmCraft', support: 'later', note: 'Has a theme setting; matched once CreateCraft opens video in FilmCraft' },
  { id: 'lightcraft', name: 'LightCraft', support: 'later', note: 'Has a theme setting; matched once CreateCraft opens LightCraft' },
  { id: 'effectcraft', name: 'EffectCraft', support: 'manual', note: 'No theme control found: set it in EffectCraft yourself' },
];

/** The app's own theme value for a CreateCraft palette. */
export function appThemeValue(appId: string, palette: ThemePalette): string | null {
  switch (appId) {
    // PhotoCraft built-in themes: proMedium is its charcoal default (what ArtCraft Match is measured from).
    case 'photocraft': return palette === 'light' ? 'studioLight' : palette === 'studioDark' ? 'pro' : 'proMedium';
    case 'vectorcraft': return palette === 'light' ? 'light' : palette === 'studioDark' ? 'dark' : 'mediumDark';
    case 'soundcraft': return palette === 'light' ? 'light' : 'dark';
    default: return null;
  }
}
