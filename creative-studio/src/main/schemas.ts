// Runtime validation for everything that crosses a trust boundary (IPC, files on disk).

import { z } from 'zod';
import type { ProjectManifest } from '@shared/types';
import type { WorkflowGraph } from '@shared/workflow';

const id = z.string().min(1).max(128);
const params = z.record(z.string().max(64), z.string().max(4000));

export const workflowSchema = z.object({
  schemaVersion: z.literal(1),
  nodes: z
    .array(
      z.object({
        id,
        type: z.enum(['import', 'aiGenerate', 'artcraftEdit', 'approval', 'export']),
        position: z.object({ x: z.number().finite(), y: z.number().finite() }),
        params,
      }),
    )
    .max(500),
  edges: z.array(z.object({ id, source: id, sourceHandle: id, target: id, targetHandle: id })).max(2000),
});

export function parseWorkflow(raw: unknown): WorkflowGraph {
  return workflowSchema.parse(raw);
}

const assetSchema = z.object({
  id,
  name: z.string().max(512),
  kind: z.enum(['image', 'video', 'audio', 'vector', 'design', 'project', 'document', 'sheet', 'deck', 'ui', 'cad']),
  relPath: z.string().max(1024).refine((p) => !p.split('/').includes('..') && !/^[a-zA-Z]:|^\//.test(p), 'relPath must be relative'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
  sourceFormat: z.string().max(32),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSec: z.number().nonnegative().optional(),
  rating: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
  approval: z.enum(['none', 'approved', 'rejected']),
  provenance: z.object({
    origin: z.enum(['imported', 'generated', 'fixture']),
    source: z.string().max(2000),
    prompt: z.string().max(4000).optional(),
    provider: z.string().max(128).optional(),
    model: z.string().max(128).optional(),
    createdAt: z.string(),
    licensingNotes: z.string().max(2000).optional(),
    settings: z.record(z.string().max(64), z.string().max(256)).optional(),
    estimatedCostUsd: z.number().nonnegative().optional(),
    requestedBy: z.enum(['user', 'claude']).optional(),
    referenceAssetIds: z.array(id).max(8).optional(),
    role: z.literal('reference').optional(),
    originalPath: z.string().max(1024).optional(),
  }),
  parentId: id.optional(),
});

export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  layout: z.literal(2).optional(),
  id,
  name: z.string().max(256),
  createdAt: z.string(),
  updatedAt: z.string(),
  assets: z.array(assetSchema),
  kind: z.enum(['image', 'design', 'video', 'audio', 'mixed']).optional(),
  brief: z.string().max(2000).optional(),
  objective: z.string().max(600).optional(),
  view: z.object({
    workspace: z.enum(['home', 'media', 'edit', 'generate', 'workflow', 'effects', 'color', 'audio', 'deliver']),
    assetId: id.optional(),
  }).optional(),
});

export function parseManifest(raw: unknown): ProjectManifest {
  return manifestSchema.parse(raw);
}
