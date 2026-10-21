import type { ModelProvider, ProviderReply } from '../types';
/** Fully offline, deterministic replies. Useful for replaying real controller and permission tests. */
export class ScriptedProvider implements ModelProvider {
  readonly id='scripted'; readonly supportsVision=false;
  private index=0;
  constructor(private readonly script: ProviderReply[]) {}
  async complete(input: Parameters<ModelProvider['complete']>[0]): Promise<ProviderReply> {
    if (input.signal.aborted) throw new Error('Aborted');
    const reply=this.script[this.index++];
    if (!reply) throw new Error('ScriptedProvider has no more responses.');
    return reply;
  }
}
