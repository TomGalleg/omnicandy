import { describe, expect, it } from 'vitest';
import { ADVANCED_NAV, HIDDEN_WORKSPACES, isMoreWorkspace, MORE_NAV, parseNavMode, shownWorkspace, SIMPLE_NAV } from './navigation';
import { shouldShowTimeline } from './timeline';

describe('navigation', () => {
  it('simplified plus More reaches every advanced workspace', () => {
    const ids = [...SIMPLE_NAV, ...MORE_NAV].map((n) => n.id).sort();
    expect(ids).toEqual(ADVANCED_NAV.map((n) => n.id).sort());
    expect(SIMPLE_NAV.map((n) => n.label)).toEqual(['Project', 'Planner', 'Create', 'AI Generate', 'Deliver']);
    expect(MORE_NAV.map((n) => n.id)).toEqual(['media', 'effects', 'color', 'audio', 'software']);
  });
  it('hides Workflow from the tabs and sends any request for it Home', () => {
    expect(HIDDEN_WORKSPACES).toEqual(['workflow']);
    expect([...ADVANCED_NAV, ...SIMPLE_NAV, ...MORE_NAV].some((n) => n.id === 'workflow')).toBe(false);
    expect(shownWorkspace('workflow')).toBe('home');
    expect(shownWorkspace('media')).toBe('media');
  });
  it('detects specialist workspaces and parses the saved preference', () => {
    expect(isMoreWorkspace('audio')).toBe(true);
    expect(isMoreWorkspace('edit')).toBe(false);
    expect(parseNavMode('advanced')).toBe('advanced');
    expect(parseNavMode('junk')).toBe('simplified');
    expect(parseNavMode(null)).toBe('simplified');
  });
  it('timelines show only while editing time-based media', () => {
    expect(shouldShowTimeline('video', 'edit')).toBe(true);
    expect(shouldShowTimeline('audio', 'audio')).toBe(true);
    for (const w of ['home', 'media', 'generate', 'workflow', 'deliver'] as const) expect(shouldShowTimeline('video', w)).toBe(false);
  });
});
