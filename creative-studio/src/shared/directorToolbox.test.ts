import { describe, expect, it } from 'vitest';
import { TOOLBOXES } from './directorToolbox';
import { defaultPolicy, effectiveLevel } from './teamAccess';
import { classifyToolCall } from './teamToolAccess';
import { DIRECTORS } from './town';

describe('every director starts well set up', () => {
  it('has a toolbox for all nine directors', () => {
    expect(Object.keys(TOOLBOXES).sort()).toEqual(DIRECTORS.map((d) => d.key).sort());
  });

  it('lists only tools that are cleared, and each one can be used inside the ceiling', () => {
    for (const [key, box] of Object.entries(TOOLBOXES)) {
      expect(new Set(box.tools).size, key).toBe(box.tools.length);
      for (const t of box.tools) {
        const req = classifyToolCall(t, { command: 'filter.blur.gaussianBlur' });
        expect(req, `${key}: ${t}`).not.toBeNull();
        expect(effectiveLevel({ ...defaultPolicy(key), ceiling: box.ceiling }, req!.capability), `${key}: ${t} has no access under the ceiling`).not.toBe('none');
      }
    }
  });

  it('never hands any director a tool that installs, publishes or is never run', () => {
    for (const [key, box] of Object.entries(TOOLBOXES)) for (const t of box.tools) {
      const kind = classifyToolCall(t, { command: 'filter.blur.gaussianBlur' })!.kind;
      expect(['install', 'publish', 'never'], `${key}: ${t}`).not.toContain(kind);
    }
  });

  it('keeps advisers to looking and suggesting: nothing that changes files or spends money', () => {
    for (const [key, box] of Object.entries(TOOLBOXES).filter(([, b]) => !b.works)) {
      for (const t of box.tools) {
        const req = classifyToolCall(t, {})!;
        expect(req.kind === 'read' || t === 'planner_propose', `${key}: ${t}`).toBe(true);
      }
      expect(box.ceiling['edit-project'], key).toBeUndefined();
      expect(box.ceiling['native-apps'], key).toBeUndefined();
      expect(['read', undefined], key).toContain(box.ceiling['generate-media']);
    }
  });

  it('lets hands-on directors report their work, and only them', () => {
    for (const [key, box] of Object.entries(TOOLBOXES)) {
      expect(box.tools.includes('planner_report'), key).toBe(box.works);
      expect(box.tools.includes('planner_claim'), key).toBe(box.works);
    }
  });

  it('starts the careful ones Supervised: programs, files and models', () => {
    for (const k of ['software-director', 'media-manager', 'ai-director', 'quality-director', 'technical-director'] as const) expect(TOOLBOXES[k].preset, k).toBe('supervised');
    expect(TOOLBOXES['creative-director'].preset).toBe('balanced');
  });

  it('sends all AI work through the AI Director: only they hold AI tools without a route to them', () => {
    const AI = ['generate_image', 'generate_video', 'make_local_video', 'make_motion_video', 'request_model_download'];
    for (const [key, box] of Object.entries(TOOLBOXES)) {
      const has = box.tools.some((t) => AI.includes(t));
      if (key === 'ai-director') { expect(box.aiVia, key).toBeUndefined(); expect(has, key).toBe(true); continue; }
      if (has) expect(box.aiVia, `${key} has an AI tool but does not go through the AI Director`).toBe('ai-director');
    }
  });

  it('gives the director who uses other programs that access and nobody else', () => {
    const who = Object.entries(TOOLBOXES).filter(([, b]) => b.ceiling['outside-apps'] === 'allow').map(([k]) => k);
    expect(who).toEqual(['software-director']);
  });
});
