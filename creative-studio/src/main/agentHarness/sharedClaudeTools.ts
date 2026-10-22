/**
 * Claude tools that Independent AI reuses unchanged (ClaudePartner.agentToolDefs), grouped by family.
 *
 * Left out on purpose:
 *  - get_status, list_files, open_file, new_document, apply_edit, app_commands, app_command, undo, save_version,
 *    look_at_document, external_*: Independent AI has its own, verification-aware versions.
 *  - export tools: shared through exportOps.ts instead.
 *  - integration_builder_*: starts a background build of new connector code; not part of agent parity.
 */
export const SHARED_CLAUDE_TOOL_FAMILIES = {
  timeline: ['timeline_add', 'timeline_move_clip', 'timeline_remove_clip'],
  workflow: ['workflow_catalog', 'plan_workflow', 'workflow_status', 'run_workflow', 'rerun_workflow', 'pause_workflow', 'resume_workflow', 'cancel_workflow',
    'change_workflow_step', 'list_workflow_versions', 'restore_workflow_version', 'save_workflow_template'],
  planner: ['planner_packages', 'planner_get_package', 'planner_claim', 'planner_report', 'planner_propose'],
  // Paid providers: the handler itself asks the user (price dialog, spending limit) before anything is sent.
  generation: ['list_image_models', 'generate_image', 'list_video_models', 'generate_video'],
  // Free local AI; request_model_download shows the license/size dialog and downloads nothing unless the user accepts.
  localMedia: ['local_video_status', 'make_local_video', 'make_motion_video', 'request_model_download'],
  photocraft: ['photocraft_command'],
} as const;

export const SHARED_CLAUDE_TOOL_NAMES: readonly string[] = Object.values(SHARED_CLAUDE_TOOL_FAMILIES).flat();
