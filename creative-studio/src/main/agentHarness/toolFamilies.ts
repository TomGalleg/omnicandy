import { z } from 'zod';
import type { Message, ToolDef } from './types';
import { tool, type ToolRegistry } from './registry';

/**
 * Optional tool families. Every advertised tool definition is resent to the model on EVERY turn, and these four
 * families made up about 64% of the tool text in the measured Blender task while a small editing task never needs them.
 * They are therefore advertised only after the model asks for them with `enable_tools`; nothing is removed:
 * the same handlers, schemas, approvals and permissions apply once a family is on, and a resumed task gets back the
 * families its transcript already used.
 */
export const OPTIONAL_TOOL_FAMILIES = {
  planner: {
    summary: 'Project Planner packages: read, claim, report on and propose changes to the user\'s prepared plans',
    tools: ['planner_packages', 'planner_get_package', 'planner_claim', 'planner_report', 'planner_propose'],
  },
  workflow: {
    summary: 'saved workflows: catalog, plan, run, rerun, pause, change steps, versions, templates (running asks the user)',
    tools: ['workflow_catalog', 'plan_workflow', 'workflow_status', 'run_workflow', 'rerun_workflow', 'pause_workflow', 'resume_workflow', 'cancel_workflow', 'change_workflow_step', 'list_workflow_versions', 'restore_workflow_version', 'save_workflow_template'],
  },
  generation: {
    summary: 'AI image and video generation (paid: the user must approve the price and may decline)',
    tools: ['list_image_models', 'generate_image', 'list_video_models', 'generate_video'],
  },
  local_media: {
    summary: 'free local AI video, Motion Effects and local model downloads (the user approves downloads)',
    tools: ['local_video_status', 'make_local_video', 'make_motion_video', 'request_model_download'],
  },
} as const;
export type OptionalFamily = keyof typeof OPTIONAL_TOOL_FAMILIES;
export const OPTIONAL_FAMILY_NAMES = Object.keys(OPTIONAL_TOOL_FAMILIES) as [OptionalFamily, ...OptionalFamily[]];

/** System-prompt line that tells the model the families exist (static text, so the prompt prefix stays stable). */
export const optionalFamiliesPrompt = (): string =>
  `\nSome tool families are switched off to save tokens: ${OPTIONAL_FAMILY_NAMES.map((n) => `${n} (${OPTIONAL_TOOL_FAMILIES[n].summary})`).join('; ')}. Call enable_tools with the family name before you need them; they appear from your next step. All editing, timeline, export, external-application, job and verification tools are always available.`;

/** Families whose tools were already called in a transcript (resume). */
export function familiesUsedIn(messages: readonly Message[] | undefined): Set<OptionalFamily> {
  const used = new Set<OptionalFamily>();
  for (const m of messages ?? []) {
    if (m.role !== 'assistant') continue;
    for (const c of m.toolCalls ?? []) {
      for (const name of OPTIONAL_FAMILY_NAMES) if ((OPTIONAL_TOOL_FAMILIES[name].tools as readonly string[]).includes(c.name)) used.add(name);
      if (c.name === 'enable_tools') {
        const f = (c.args as { family?: unknown } | null)?.family;
        if (typeof f === 'string' && (OPTIONAL_FAMILY_NAMES as readonly string[]).includes(f)) used.add(f as OptionalFamily);
      }
    }
  }
  return used;
}

/**
 * Adds the shared tool definitions: core ones immediately, optional families behind `enable_tools`.
 * Calling a not-yet-enabled tool returns a hint that names the family.
 */
export function registerSharedTools(registry: ToolRegistry, defs: readonly ToolDef[], enabledAtStart: ReadonlySet<OptionalFamily> = new Set()): void {
  const familyOf = new Map<string, OptionalFamily>();
  for (const f of OPTIONAL_FAMILY_NAMES) for (const t of OPTIONAL_TOOL_FAMILIES[f].tools) familyOf.set(t, f);
  const deferred = new Map<OptionalFamily, ToolDef[]>();
  const enabled = new Set<OptionalFamily>();
  const turnOn = (family: OptionalFamily): ToolDef[] => {
    if (enabled.has(family)) return [];
    enabled.add(family);
    const list = deferred.get(family) ?? [];
    for (const def of list) registry.add(def);
    return list;
  };
  for (const def of defs) {
    const family = familyOf.get(def.name);
    if (!family) { registry.add(def); continue; }
    deferred.set(family, [...(deferred.get(family) ?? []), def]);
    registry.hint(def.name, `This tool is in the optional "${family}" family: call enable_tools {"family":"${family}"} first.`);
  }
  for (const f of enabledAtStart) turnOn(f);
  const available = OPTIONAL_FAMILY_NAMES.filter((f) => deferred.has(f));
  if (!available.length) return;
  registry.add(tool('enable_tools', `Switch on an optional tool family so its tools are advertised from your next step. Families: ${available.map((f) => `${f} (${OPTIONAL_TOOL_FAMILIES[f].summary})`).join('; ')}.`,
    z.object({ family: z.enum(available as [OptionalFamily, ...OptionalFamily[]]) }).strict(), async ({ family }) => {
      const added = turnOn(family);
      return added.length
        ? `Enabled ${family}: ${added.map((d) => d.name).join(', ')}. They are available from your next step; approvals and permissions are unchanged.`
        : `The ${family} tools are already enabled.`;
    }));
}
