import { describe, expect, it } from 'vitest';
import { isPlannerTab, PLANNER_TABS, resolvePlannerTab, SIMPLE_PLANNER_TABS } from './plannerTabs';

describe('which Planner tab a project opens on', () => {
  it('opens Studio when nothing was saved, or what was saved is not a tab', () => {
    for (const v of [undefined, null, '', 'nope', 42, {}, 'TOWN']) { expect(resolvePlannerTab(v, false)).toBe('studio'); expect(resolvePlannerTab(v, true)).toBe('studio'); }
  });

  it('opens the tab the owner last used, for every simple tab, in both modes', () => {
    for (const t of SIMPLE_PLANNER_TABS) { expect(resolvePlannerTab(t, false)).toBe(t); expect(resolvePlannerTab(t, true)).toBe(t); }
  });

  it('shows Studio for an Advanced-only tab in Simplified mode, and the tab itself in Advanced mode', () => {
    for (const t of PLANNER_TABS.filter((x) => !SIMPLE_PLANNER_TABS.includes(x))) { expect(resolvePlannerTab(t, false)).toBe('studio'); expect(resolvePlannerTab(t, true)).toBe(t); }
  });

  it('knows what a tab is', () => {
    expect(PLANNER_TABS.every(isPlannerTab)).toBe(true);
    expect(isPlannerTab('studio')).toBe(true);
    expect(isPlannerTab('Studio')).toBe(false);
    expect(isPlannerTab(undefined)).toBe(false);
  });
});
