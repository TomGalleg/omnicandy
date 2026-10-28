// The seams for later stages (docs/planner-2.0/stage-1-blueprint.md, section 4.8). Only types and "nothing is connected yet" objects live here:
// capabilities come from the connected programs (stage 3), execution from the existing agent loop (stage 3), teams and towns from their own
// stages. Declaring them now means the planner, Studio and Village can be written against them without knowing which stage built them.
import type { Permission } from './integrations';
import type { PlanTask } from './planner';

export interface CapabilityDescriptor {
  /** `${providerKind}:${providerId}:${commandId}` */
  id: string;
  providerKind: 'native' | 'external' | 'agent' | 'workflow';
  /** An ArtCraft app id, an adapter id ('blender', 'unreal', 'autodesk.fusion', 'davinci.resolve', ...), or a workflow key. */
  providerId: string;
  label: string;
  /** What it makes, in plain kinds such as 'image', 'model.3d', 'video'. */
  produces: string[];
  requires: Permission[];
  availability: 'verified' | 'declared' | 'unavailable';
  reversible: boolean | 'unknown';
  paid: boolean;
  destructive: boolean;
  headless: boolean | 'unknown';
  /** A trusted read-back command that can check the result (see integrations/readback.ts). */
  verifyWith?: string;
}
export interface CapabilityMatch { capability: CapabilityDescriptor; why: string }
export interface TaskReadiness { taskId: string; state: 'ready' | 'needs-setup' | 'manual-only' | 'unknown'; matches: CapabilityMatch[]; problems: string[] }

export interface CapabilityPort {
  search(q: { intent: string; outputs?: string[] }): Promise<CapabilityMatch[]>;
  readiness(task: PlanTask): Promise<TaskReadiness>;
}

export interface DispatchRequest { planId: string; taskId: string; capabilityId?: string; budget?: { maxTurns?: number; maxToolCalls?: number; maxUsd?: number } }
export interface DispatchHandle { runId: string }
export interface ExecutionPort {
  readonly available: boolean;
  dispatch(req: DispatchRequest): Promise<DispatchHandle>;
  cancel(runId: string): Promise<void>;
}

/** No capability catalogue yet: every task is "do it yourself or copy it to an AI", which is what the Work tab does today. */
export const NULL_CAPABILITIES: CapabilityPort = {
  search: async () => [],
  readiness: async (task) => ({ taskId: task.id, state: 'manual-only', matches: [], problems: [] }),
};

/** No execution engine connected yet. Asking it to run something fails clearly instead of pretending. */
export const NULL_EXECUTION: ExecutionPort = {
  available: false,
  dispatch: async () => { throw new Error('Starting work from OmniTown is not available yet. Copy the instructions to an AI instead.'); },
  cancel: async () => undefined,
};
