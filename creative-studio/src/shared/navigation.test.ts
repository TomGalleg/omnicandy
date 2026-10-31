import { describe, expect, it } from 'vitest';
import { HIDDEN_WORKSPACES, NAV, routeWorkspace, shownWorkspace } from './navigation';
import { shouldShowTimeline } from './timeline';

describe('navigation', () => {
  it('has one toolbar with Media on it directly, and no More menu or Advanced mode', () => {
    expect(NAV.map((n) => n.label)).toEqual(['Project', 'Media', 'Edit', 'AI Generate', 'Software', 'Planner', 'Deliver']);
    expect(NAV.map((n) => n.id)).toEqual(['home', 'media', 'edit', 'generate', 'software', 'planner', 'deliver']);
    expect(NAV.slice(-3).map((n) => n.id)).toEqual(['software', 'planner', 'deliver']);
  });
  it('sends the old Effects, Color and Audio tabs into Edit modes', () => {
    expect(routeWorkspace('color')).toEqual({ workspace: 'edit', mode: 'color' });
    expect(routeWorkspace('effects')).toEqual({ workspace: 'edit', mode: 'effects' });
    expect(routeWorkspace('audio')).toEqual({ workspace: 'edit', mode: 'edit' });
    expect(routeWorkspace('edit')).toEqual({ workspace: 'edit' });
    expect(routeWorkspace('software')).toEqual({ workspace: 'software' });
  });
  it('hides Workflow from the tabs and sends any request for it Home', () => {
    expect(HIDDEN_WORKSPACES).toEqual(['workflow']);
    expect(NAV.some((n) => n.id === 'workflow')).toBe(false);
    expect(shownWorkspace('workflow')).toBe('home');
    expect(shownWorkspace('media')).toBe('media');
  });
  it('timelines show only while editing time-based media', () => {
    expect(shouldShowTimeline('video', 'edit')).toBe(true);
    expect(shouldShowTimeline('audio', 'audio')).toBe(true);
    for (const w of ['home', 'media', 'generate', 'workflow', 'deliver'] as const) expect(shouldShowTimeline('video', w)).toBe(false);
  });
});
