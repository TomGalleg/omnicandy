import { describe, expect, it } from 'vitest';
import { ACCENT_PRESETS, accentForeground, accentOnSurface, contrastRatio, DEFAULT_APPEARANCE, resolveTheme, sanitizeAppearance, SURFACES } from './theme';
import { shouldShowTimeline } from './timeline';

describe('theme', () => {
  it('resolves system mode from the OS preference and leaves explicit modes alone', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('sanitizes untrusted persisted settings field by field', () => {
    expect(sanitizeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(sanitizeAppearance({ mode: 'neon', accent: '#ABCDEF' })).toEqual({ mode: 'system', accent: '#abcdef' });
    expect(sanitizeAppearance({ mode: 'light', accent: 'red; background:url(x)' })).toEqual({ mode: 'light', accent: DEFAULT_APPEARANCE.accent });
  });

  it('computes WCAG contrast correctly', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });

  it('keeps text on every accent preset at >= 4.5:1, and accent text legible on both themes', () => {
    for (const { value } of [...ACCENT_PRESETS, { value: '#ffff00' }, { value: '#101010' }]) {
      expect(contrastRatio(value, accentForeground(value))).toBeGreaterThanOrEqual(4.5);
      for (const t of ['dark', 'light'] as const) {
        expect(contrastRatio(accentOnSurface(value, SURFACES[t], t), SURFACES[t])).toBeGreaterThanOrEqual(4.5);
      }
    }
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
