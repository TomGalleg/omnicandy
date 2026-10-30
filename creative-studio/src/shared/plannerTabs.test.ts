import { describe, expect, it } from 'vitest';
import { isPlannerTab, PLANNER_TABS, resolvePlannerTab, SIMPLE_PLANNER_TABS } from './plannerTabs';

describe('which Planner tab a project opens on', () => {
  it('opens Studio in Advanced mode when nothing was saved, or what was saved is not a tab', () => {
    for (const v of [undefined, null, '', 'nope', 42, {}, 'TOWN']) expect(resolvePlannerTab(v, true)).toBe('studio');
  });

  it('opens the tab the owner last used in Advanced mode, for every tab', () => {
    for (const t of PLANNER_TABS) expect(resolvePlannerTab(t, true)).toBe(t);
  });

  it('has one view in Simplified mode, OmniTown, whatever was saved', () => {
    for (const v of [...PLANNER_TABS, undefined, null, 'nope', 42]) expect(resolvePlannerTab(v, false)).toBe('town');
    expect(SIMPLE_PLANNER_TABS).toEqual(['town']);
  });

  it('knows what a tab is', () => {
    expect(PLANNER_TABS.every(isPlannerTab)).toBe(true);
    expect(isPlannerTab('studio')).toBe(true);
    expect(isPlannerTab('Studio')).toBe(false);
    expect(isPlannerTab(undefined)).toBe(false);
  });
});
