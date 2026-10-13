import type { AppearanceSettings, ThemeMode } from './types';

export const DEFAULT_APPEARANCE: AppearanceSettings = { mode: 'system', accent: '#4f7cff' };

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
const MODES: readonly ThemeMode[] = ['dark', 'light', 'system'];

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX.test(v);
}

/** Coerces untrusted persisted data into valid settings, falling back field by field. */
export function sanitizeAppearance(raw: unknown): AppearanceSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    mode: MODES.includes(r.mode as ThemeMode) ? (r.mode as ThemeMode) : DEFAULT_APPEARANCE.mode,
    accent: isHexColor(r.accent) ? r.accent.toLowerCase() : DEFAULT_APPEARANCE.accent,
  };
}

export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): 'dark' | 'light' {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light';
  return mode;
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

export const SURFACES = { dark: '#15171c', light: '#ffffff' } as const;
