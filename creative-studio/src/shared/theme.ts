import type { AppearanceSettings, ThemeMode, ThemePalette } from './types';

/** New installs: follow Windows, with ArtCraft Match as the dark look. */
export const DEFAULT_APPEARANCE: AppearanceSettings = { version: 2, mode: 'system', accent: '#4f7cff', systemDark: 'artcraft', syncApps: true };

export const THEME_OPTIONS: ReadonlyArray<{ id: ThemeMode; label: string; hint: string }> = [
  { id: 'artcraft', label: 'ArtCraft Match', hint: 'Charcoal grey, matches PhotoCraft and the other ArtCraft apps' },
  { id: 'studioDark', label: 'Studio Dark', hint: 'The original near-black OmniCandy look' },
  { id: 'light', label: 'Light', hint: 'Light grey, matches the ArtCraft light themes' },
  { id: 'system', label: 'System', hint: 'Follows Windows dark/light' },
];

export type ThemeTokens = Record<
  'bg' | 'surface' | 'surface-2' | 'surface-3' | 'border' | 'border-strong' | 'text' | 'text-2' | 'text-3'
  | 'mock' | 'mock-bg' | 'ok' | 'ok-bg' | 'warn' | 'danger' | 'danger-bg' | 'checker-a' | 'checker-b' | 'shadow' | 'editor-bg',
  string
>;

/**
 * Palettes. ArtCraft Match is measured from PhotoCraft's own "proMedium" theme (canvas surround
 * #282828, panels #535353, fields #424242); Light is coordinated with PhotoCraft's "studioLight"
 * (#e2e2e6 / #f6f6f8 / #fcfcfd). Studio Dark is the original OmniCandy palette, unchanged.
 */
export const PALETTES: Record<ThemePalette, ThemeTokens> = {
  artcraft: {
    bg: '#282828', surface: '#535353', 'surface-2': '#474747', 'surface-3': '#5e5e5e',
    border: '#3f3f3f', 'border-strong': '#6b6b6b', text: '#f0f0f0', 'text-2': '#dadada', 'text-3': '#c8c8c8',
    mock: '#f0b34a', 'mock-bg': '#4a3d26', ok: '#5fdc94', 'ok-bg': '#2f4a3a', warn: '#f2bf55', danger: '#ff8a8a', 'danger-bg': '#5a3434',
    'checker-a': '#3a3a3a', 'checker-b': '#444444', shadow: '0 8px 24px rgb(0 0 0 / 0.35)', 'editor-bg': '#282828',
  },
  studioDark: {
    bg: '#0f1115', surface: '#15171c', 'surface-2': '#1b1e25', 'surface-3': '#232731',
    border: '#2a2e38', 'border-strong': '#3a3f4c', text: '#e8eaef', 'text-2': '#a9afbd', 'text-3': '#7d8494',
    mock: '#e0a33a', 'mock-bg': '#3a2c12', ok: '#3ccf7a', 'ok-bg': '#12301f', warn: '#f0b33f', danger: '#ff6b6b', 'danger-bg': '#3a1618',
    'checker-a': '#1c1f26', 'checker-b': '#22262f', shadow: '0 8px 24px rgb(0 0 0 / 0.45)', 'editor-bg': '#0f1115',
  },
  light: {
    bg: '#e2e2e6', surface: '#f6f6f8', 'surface-2': '#fcfcfd', 'surface-3': '#ebebef',
    border: '#d5d5db', 'border-strong': '#b8b8c1', text: '#1b1b20', 'text-2': '#45454f', 'text-3': '#5c5c67',
    mock: '#7a5000', 'mock-bg': '#fff1d6', ok: '#146c3c', 'ok-bg': '#ddf5e7', warn: '#7a5000', danger: '#a8231a', 'danger-bg': '#fde4e1',
    'checker-a': '#f1f1f4', 'checker-b': '#e4e4e9', shadow: '0 8px 24px rgb(20 20 30 / 0.14)', 'editor-bg': '#e2e2e6',
  },
};

export const paletteScheme = (p: ThemePalette): 'dark' | 'light' => (p === 'light' ? 'light' : 'dark');

export const ACCENT_PRESETS: ReadonlyArray<{ name: string; value: string }> = [
  { name: 'Blue', value: '#4f7cff' },
  { name: 'Violet', value: '#8b5cf6' },
  { name: 'Teal', value: '#14b8a6' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Amber', value: '#f59e0b' },
  { name: 'Coral', value: '#f4615a' },
  { name: 'Pink', value: '#ec4899' },
];

const HEX = /^#[0-9a-fA-F]{6}$/;
const MODES: readonly ThemeMode[] = ['artcraft', 'studioDark', 'light', 'system'];

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX.test(v);
}

/**
 * Coerces untrusted persisted data into valid settings, field by field. Settings saved before
 * ArtCraft Match existed keep their look: "dark" becomes Studio Dark, and System keeps using
 * Studio Dark when Windows is dark. Only new installs get ArtCraft Match by default.
 */
export function sanitizeAppearance(raw: unknown): AppearanceSettings {
  const present = !!raw && typeof raw === 'object';
  const r = (present ? raw : {}) as Record<string, unknown>;
  const legacy = present && r.version !== 2;
  const mode = r.mode === 'dark' ? 'studioDark' : MODES.includes(r.mode as ThemeMode) ? (r.mode as ThemeMode) : DEFAULT_APPEARANCE.mode;
  const systemDark = r.systemDark === 'artcraft' || r.systemDark === 'studioDark' ? r.systemDark : legacy ? 'studioDark' : DEFAULT_APPEARANCE.systemDark;
  return {
    version: 2,
    mode,
    accent: isHexColor(r.accent) ? r.accent.toLowerCase() : DEFAULT_APPEARANCE.accent,
    systemDark,
    syncApps: typeof r.syncApps === 'boolean' ? r.syncApps : DEFAULT_APPEARANCE.syncApps,
  };
}

export function resolveTheme(s: Pick<AppearanceSettings, 'mode' | 'systemDark'>, systemPrefersDark: boolean): ThemePalette {
  if (s.mode === 'system') return systemPrefersDark ? s.systemDark : 'light';
  return s.mode;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text colour to place on an accent fill: whichever of near-black/white has more contrast. */
export function accentForeground(accent: string): string {
  return contrastRatio(accent, '#ffffff') >= contrastRatio(accent, '#0b0d12') ? '#ffffff' : '#0b0d12';
}

function mix(hex: string, target: string, t: number): string {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(target.slice(1), 16);
  const ch = (shift: number) => Math.round(((a >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t);
  return '#' + [16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('');
}

/**
 * Accent variant used for text/borders on the theme background. Darkens (light theme) or
 * lightens (dark theme) until it reaches 4.5:1 against the surface, so any user accent stays legible.
 */
export function accentOnSurface(accent: string, surface: string, theme: 'dark' | 'light'): string {
  const target = theme === 'dark' ? '#ffffff' : '#000000';
  let c = accent;
  for (let t = 0; t <= 1 && contrastRatio(c, surface) < 4.5; t += 0.05) c = mix(accent, target, t);
  return c;
}

/** Surface the accent text sits on (the panel colour) for each palette. */
export const SURFACES: Record<ThemePalette, string> = { artcraft: PALETTES.artcraft.surface, studioDark: PALETTES.studioDark.surface, light: PALETTES.light.surface };
