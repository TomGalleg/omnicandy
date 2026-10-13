// Explicitly labelled MOCK adapters. They never spawn processes or make network calls and
// always report connected: false, so the UI can never mistake them for real integrations.

import type { AppAdapter, AppOperation, GenerationJob, GenerationProvider } from './contracts';
import type { AppProbeResult } from './types';

export class MockArtCraftAdapter implements AppAdapter {
  readonly isMock = true;
  private seq = 0;
  readonly log: Array<{ documentId: string; op: AppOperation }> = [];
  constructor(readonly id: string, private readonly displayName: string) {}

  async probe(): Promise<AppProbeResult> {
    return {
      appId: this.id,
      displayName: `${this.displayName} (MOCK)`,
      installed: false,
      connected: false,
      version: null,
      capabilities: [],
      notes: ['Mock adapter: simulates results only.'],
    };
  }
  async open(assetRef: string) { return { documentId: `mock-doc:${this.id}:${assetRef}` }; }
  async execute(documentId: string, op: AppOperation) {
    this.log.push({ documentId, op });
    return { checkpointId: `mock-checkpoint:${this.id}:${++this.seq}`, outputAssetIds: [] };
  }
  async save() {}
  async export(_documentId: string, format: string) { return `mock-export.${format}`; }
}

export class MockGenerationProvider implements GenerationProvider {
  readonly id = 'mock';
  readonly isMock = true;
  readonly billable = false;
  submitted: GenerationJob[] = [];
  async listModels() { return [{ id: 'mock-image', capabilities: ['text-to-image'] }]; }
  async estimate() { return { amount: 0, currency: 'USD', approximate: false }; }
  async submit(job: GenerationJob) {
    this.submitted.push(job);
    return { jobId: `mock-job-${this.submitted.length}` };
  }
  async status() { return 'completed' as const; }
}
