// Which kind of action each tool call is, for the team access rules (teamAccess.ts). One table for both engines: the Claude panel and the agent harness
// use the same tool names, so a call is judged the same way whoever makes it. It reuses the command tiers OmniCandy already has instead of inventing risk labels.
// A tool that is not in the table is refused for a worker: a new tool must be classified on purpose.
import { appCommandTier } from './appCommands';
import { commandTier } from './photocraftOps';
import type { AccessRequest, ActionKind, Capability } from './teamAccess';

type Row = [Capability, ActionKind, string];
const READ_PROJECT = ['get_status', 'look_at_document', 'app_commands', 'list_files', 'open_file', 'list_export_formats', 'workflow_catalog', 'workflow_status', 'list_workflow_versions', 'local_video_status', 'integration_builder_status', 'planner_packages', 'planner_get_package'];
const TABLE: Record<string, Row> = {
  ...Object.fromEntries(READ_PROJECT.map((n): [string, Row] => [n, ['read-project', 'read', `Look (${n.replace(/_/g, ' ')})`]])),
  list_image_models: ['generate-media', 'read', 'See which picture makers are available'],
  list_video_models: ['generate-media', 'read', 'See which video makers are available'],
  external_apps: ['outside-apps', 'read', 'See which other programs are connected'],
  external_job: ['outside-apps', 'read', 'Check on work in another program'],
  apply_edit: ['native-apps', 'change', 'Edit the open document'],
  undo: ['native-apps', 'change', 'Undo the last change'],
  timeline_add: ['native-apps', 'change', 'Add to the timeline'],
  timeline_move_clip: ['native-apps', 'change', 'Move a clip on the timeline'],
  timeline_remove_clip: ['native-apps', 'change', 'Remove a clip from the timeline'],
  save_version: ['edit-project', 'change', 'Save a version'],
  new_document: ['edit-project', 'change', 'Start a new document'],
  export_file: ['edit-project', 'change', 'Export a file'],
  plan_workflow: ['native-apps', 'change', 'Plan a workflow'],
  pause_workflow: ['native-apps', 'change', 'Pause the workflow'],
  resume_workflow: ['native-apps', 'change', 'Resume the workflow'],
  cancel_workflow: ['native-apps', 'change', 'Cancel the workflow'],
  change_workflow_step: ['native-apps', 'change', 'Change a workflow step'],
  restore_workflow_version: ['native-apps', 'change', 'Restore an earlier workflow'],
  save_workflow_template: ['edit-project', 'change', 'Save the workflow as a template'],
  run_workflow: ['generate-media', 'spend', 'Run the workflow (may cost money)'],
  rerun_workflow: ['generate-media', 'spend', 'Run the workflow again (may cost money)'],
  generate_image: ['generate-media', 'spend', 'Make a picture with AI'],
  generate_video: ['generate-media', 'spend', 'Make a video with AI'],
  make_local_video: ['generate-media', 'change', 'Make a video on this computer'],
  make_motion_video: ['generate-media', 'change', 'Make a moving picture on this computer'],
  request_model_download: ['generate-media', 'install', 'Download an AI model'],
  external_run: ['outside-apps', 'change', 'Run something in another program'],
  integration_builder_start: ['outside-apps', 'install', 'Build a new connector to another program'],
  planner_claim: ['propose-plan', 'change', 'Take a task from the plan'],
  planner_report: ['propose-plan', 'change', 'Report on a task'],
  planner_propose: ['propose-plan', 'change', 'Suggest a change to the plan'],
};

const str = (a: unknown, k: string): string | undefined => { const v = a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined; return typeof v === 'string' ? v.slice(0, 200) : undefined; };

/** The access request for one tool call, or null when the tool is not known (refused for workers). `taskId` is the task the worker is on. */
export function classifyToolCall(name: string, args: unknown, taskId?: string): AccessRequest | null {
  const base = { ...(taskId ? { taskId } : {}) };
  if (name === 'photocraft_command' || name === 'app_command') {
    const command = str(args, 'command') ?? '';
    const tier = name === 'photocraft_command' ? commandTier(command) : appCommandTier(command);
    // "approval" commands open, save or run things: the app's own dialog asks too; here they count as risky. "never" stays refused.
    return { capability: 'native-apps', kind: tier === 'never' ? 'never' : tier === 'approval' ? 'sensitive' : 'change', target: command, label: `Run the command ${command}`, ...base };
  }
  const row = TABLE[name]; if (!row) return null;
  const target = name === 'external_run' ? str(args, 'app') ?? str(args, 'app_id') : name === 'open_file' ? str(args, 'name') : name === 'generate_image' || name === 'generate_video' ? name.slice(9) : undefined;
  return { capability: row[0], kind: row[1], label: row[2], ...(target ? { target } : {}), ...base };
}

/** Every tool the table knows, so a test can prove each tool Claude has is classified. */
export const CLASSIFIED_TOOLS: readonly string[] = [...Object.keys(TABLE), 'photocraft_command', 'app_command'];
