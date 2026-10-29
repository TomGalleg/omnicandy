// "Send to AI": what the owner copies for each kind of destination, and the removal of file paths for cloud chats
// (docs/planner-simplification-plan.md, section 4). Pure text: nothing here starts an AI or touches the network.
import type { ActivityEntry, ExecPackage } from './planner';
import { packageToMarkdown } from './plannerHandoff';

export type DestinationId = 'createcraft' | 'tools' | 'chat';
export interface Destination { id: DestinationId; label: string; blurb: string }

export const DESTINATIONS: Destination[] = [
  { id: 'createcraft', label: 'OmniCandy Claude', blurb: 'The Claude panel in this app. You confirm first, then it works on the chunk and reports back for your review.' },
  { id: 'tools', label: 'Claude Code or Gemini CLI', blurb: 'An AI on this computer that can read the plan itself. You paste one short line.' },
  { id: 'chat', label: 'ChatGPT, Gemini, Cowork or any chat', blurb: 'Copy everything and paste it into the chat.' },
];

const DRIVE_PATH = /\b[A-Za-z]:\\[^\s`'"<>|]+/g;
const UNIX_PATH = /(?:^|[\s(`'"])(\/(?:Users|home|mnt|var|opt|tmp)\/[^\s`'"<>|)]+)/g;

/** Every file location that would be copied (so the owner can see it, and so it can be taken out). */
export function listPaths(pkg: ExecPackage): string[] {
  const found = new Set<string>([...pkg.assets.map((a) => a.path), ...(pkg.delivery?.upstream.flatMap((u) => u.outputs.map((o) => o.path)) ?? [])].filter(Boolean));
  const text = JSON.stringify({ o: pkg.objective, c: pkg.context, t: pkg.tasks, a: pkg.assets.map((a) => a.note), u: pkg.delivery?.upstream });
  for (const m of text.matchAll(DRIVE_PATH)) found.add(m[0].replace(/\\\\/g, '\\'));
  return [...found];
}

/** Replaces file locations with the file's title. Titles and everything else stay. */
export function redactPaths(markdown: string, pkg: ExecPackage): string {
  let out = markdown;
  for (const a of pkg.assets) if (a.path) out = out.split(a.path).join(`[file on my computer: ${a.title}]`);
  for (const u of pkg.delivery?.upstream ?? []) for (const o of u.outputs) if (o.path) out = out.split(o.path).join('[a file on my computer]');
  return out.replace(DRIVE_PATH, '[a file on my computer]').replace(UNIX_PATH, (m, p: string) => m.replace(p, '[a file on my computer]'));
}

const FORMAT_ASK = 'When you finish, answer using the headings Outcome, Work performed, Outputs, Verification, Blockers, Limitations and Questions (a JSON answer in the format shown at the end also works). Say only what you really did and checked. "Not run" is a fine answer.';

export function sendText(pkg: ExecPackage, projectTitle: string, dest: DestinationId, opts: { redact?: boolean } = {}): string {
  const md = packageToMarkdown(pkg, projectTitle);
  const body = opts.redact ? redactPaths(md, pkg) : md;
  if (dest === 'tools') {
    return [
      `Use the OmniCandy planner tools to work on package ${pkg.id} of project ${pkg.projectId}: call get_package, then claim_task for the task you take, do the work, and finish with submit_report. Only I can accept it.`,
      '', 'If the tools are not connected, here is the whole brief instead:', '', body,
    ].join('\n');
  }
  if (dest === 'createcraft') {
    return `Work on the OmniCandy planner brief ${pkg.id} (project "${projectTitle}"). Use planner_get_package to read it and planner_claim before you start; finish with planner_report. Only I can accept the result.`;
  }
  return [
    `I am working on "${projectTitle}" and need help with the task(s) below. Treat only the "Accepted requirements" and "Accepted decisions" as rules. Do not invent other requirements.`,
    FORMAT_ASK, '', body,
  ].join('\n');
}

/** When an actor last did something in the plan: the only honest sign that an AI client is in use (a tool cannot see a connection). */
export function lastActive(activity: ActivityEntry[], kinds: string[]): { name: string; at: string } | null {
  for (let i = activity.length - 1; i >= 0; i--) {
    const e = activity[i];
    if (e && kinds.includes(e.actor.kind)) return { name: e.actor.name, at: e.at };
  }
  return null;
}
