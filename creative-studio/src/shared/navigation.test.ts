import { describe, expect, it } from 'vitest';
import { ADVANCED_NAV, HIDDEN_WORKSPACES, isMoreWorkspace, MORE_NAV, parseNavMode, routeWorkspace, shownWorkspace, SIMPLE_NAV } from './navigation';
import { shouldShowTimeline } from './timeline';

describe('navigation', () => {
  it('simplified plus More reaches every advanced workspace', () => {
    const ids = [...SIMPLE_NAV, ...MORE_NAV].map((n) => n.id).sort();
    expect(ids).toEqual(ADVANCED_NAV.map((n) => n.id).sort());
    expect(SIMPLE_NAV.map((n) => n.label)).toEqual(['Project', 'Edit', 'AI Generate', 'Software', 'Planner', 'Deliver']);
    expect(MORE_NAV.map((n) => n.id)).toEqual(['media']);
    expect(ADVANCED_NAV.map((n) => n.id)).toEqual(['home', 'media', 'edit', 'generate', 'software', 'planner', 'deliver']);
  });
  it('sends the old Effects, Color and Audio tabs into Edit modes', () => {
    expect(routeWorkspace('color')).toEqual({ workspace: 'edit', mode: 'color' });
    expect(routeWorkspace('effects')).toEqual({ workspace: 'edit', mode: 'effects' });
    expect(routeWorkspace('audio')).toEqual({ workspace: 'edit', mode: 'edit' });
    expect(routeWorkspace('edit')).toEqual({ workspace: 'edit' });
    expect(routeWorkspace('software')).toEqual({ workspace: 'software' });
  });
  it('ends with Software, Planner, Deliver in both layouts', () => {
    expect(ADVANCED_NAV.slice(-3).map((n) => n.id)).toEqual(['software', 'planner', 'deliver']);
    expect(SIMPLE_NAV.slice(-3).map((n) => n.id)).toEqual(['software', 'planner', 'deliver']);
  });
  it('hides Workflow from the tabs and sends any request for it Home', () => {
    expect(HIDDEN_WORKSPACES).toEqual(['workflow']);
    expect([...ADVANCED_NAV, ...SIMPLE_NAV, ...MORE_NAV].some((n) => n.id === 'workflow')).toBe(false);
    expect(shownWorkspace('workflow')).toBe('home');
    expect(shownWorkspace('media')).toBe('media');
  });
  it('detects specialist workspaces and parses the saved preference', () => {
    expect(isMoreWorkspace('media')).toBe(true);
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
