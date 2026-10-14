import { describe, expect, it } from 'vitest';
import { appThemeValue } from './appTheme';
import { ACCENT_PRESETS, accentForeground, accentOnSurface, contrastRatio, DEFAULT_APPEARANCE, PALETTES, paletteScheme, resolveTheme, sanitizeAppearance, SURFACES } from './theme';
import { shouldShowTimeline } from './timeline';

describe('theme', () => {
  it('resolves each mode to a palette; System follows Windows using the chosen dark look', () => {
    expect(resolveTheme({ mode: 'system', systemDark: 'artcraft' }, true)).toBe('artcraft');
    expect(resolveTheme({ mode: 'system', systemDark: 'studioDark' }, true)).toBe('studioDark');
    expect(resolveTheme({ mode: 'system', systemDark: 'artcraft' }, false)).toBe('light');
    expect(resolveTheme({ mode: 'studioDark', systemDark: 'artcraft' }, false)).toBe('studioDark');
    expect(resolveTheme({ mode: 'artcraft', systemDark: 'studioDark' }, false)).toBe('artcraft');
    expect(resolveTheme({ mode: 'light', systemDark: 'artcraft' }, true)).toBe('light');
  });

  it('new installs default to System with ArtCraft Match as the dark look, app sync on', () => {
    expect(sanitizeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(DEFAULT_APPEARANCE).toMatchObject({ mode: 'system', systemDark: 'artcraft', syncApps: true });
  });

  it('preserves preferences saved before ArtCraft Match existed', () => {
    expect(sanitizeAppearance({ mode: 'dark', accent: '#14B8A6' })).toEqual({ version: 2, mode: 'studioDark', accent: '#14b8a6', systemDark: 'studioDark', syncApps: true });
    expect(sanitizeAppearance({ mode: 'system', accent: '#4f7cff' })).toMatchObject({ mode: 'system', systemDark: 'studioDark' });
    expect(sanitizeAppearance({ mode: 'light', accent: '#4f7cff' })).toMatchObject({ mode: 'light' });
  });

  it('sanitizes untrusted persisted settings field by field', () => {
    expect(sanitizeAppearance({ version: 2, mode: 'neon', accent: '#ABCDEF', systemDark: 'x', syncApps: 'yes' }))
      .toEqual({ version: 2, mode: 'system', accent: '#abcdef', systemDark: 'artcraft', syncApps: true });
    expect(sanitizeAppearance({ version: 2, mode: 'light', accent: 'red; background:url(x)', syncApps: false }))
      .toMatchObject({ mode: 'light', accent: DEFAULT_APPEARANCE.accent, syncApps: false });
  });

  it('computes WCAG contrast correctly', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });

  it('every palette keeps text readable (>= 4.5:1) on its backgrounds, panels and fields', () => {
    for (const [name, t] of Object.entries(PALETTES)) {
      for (const bgKey of ['bg', 'surface', 'surface-2'] as const) {
        for (const fg of ['text', 'text-2'] as const) {
          expect(contrastRatio(t[fg], t[bgKey]), `${name} ${fg} on ${bgKey}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      if (name !== 'studioDark') { // Studio Dark is kept exactly as it was
        expect(contrastRatio(t['text-3'], t.surface), `${name} text-3`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(t.danger, t['danger-bg']), `${name} danger`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('ArtCraft Match uses the colours measured from PhotoCraft', () => {
    expect(PALETTES.artcraft).toMatchObject({ bg: '#282828', surface: '#535353', 'editor-bg': '#282828' });
  });

  it('keeps text on every accent preset at >= 4.5:1, and accent text legible on every palette', () => {
    for (const { value } of [...ACCENT_PRESETS, { value: '#ffff00' }, { value: '#101010' }]) {
      expect(contrastRatio(value, accentForeground(value))).toBeGreaterThanOrEqual(4.5);
      for (const p of ['artcraft', 'studioDark', 'light'] as const) {
        expect(contrastRatio(accentOnSurface(value, SURFACES[p], paletteScheme(p)), SURFACES[p])).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('ArtCraft theme sync values', () => {
  it('maps each palette to the app theme names', () => {
    expect(appThemeValue('photocraft', 'artcraft')).toBe('proMedium');
    expect(appThemeValue('photocraft', 'light')).toBe('studioLight');
    expect(appThemeValue('vectorcraft', 'artcraft')).toBe('mediumDark');
    expect(appThemeValue('vectorcraft', 'studioDark')).toBe('dark');
    expect(appThemeValue('soundcraft', 'light')).toBe('light');
    expect(appThemeValue('filmcraft', 'artcraft')).toBe('dark');
    expect(appThemeValue('filmcraft', 'studioDark')).toBe('darkest');
    expect(appThemeValue('lightcraft', 'light')).toBe('light');
    expect(appThemeValue('effectcraft', 'artcraft')).toBe('dark');
    expect(appThemeValue('designcraft', 'artcraft')).toBe('mediumDark');
    expect(appThemeValue('designcraft', 'light')).toBe('light');
    expect(appThemeValue('cadcraft', 'light')).toBeNull();
  });
});

describe('timeline visibility', () => {
  it('shows a timeline only for time-based media', () => {
    expect(shouldShowTimeline('audio')).toBe(true);
    expect(shouldShowTimeline('video')).toBe(true);
    for (const k of ['image', 'vector', 'design', 'project'] as const) expect(shouldShowTimeline(k)).toBe(false);
    expect(shouldShowTimeline(null)).toBe(false);
  });
});
