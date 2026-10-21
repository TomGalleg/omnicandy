import { describe, expect, it } from 'vitest';
import type { AgentUiState } from './agentHarness';
import { presentUnifiedAgent, validateUnifiedAgentRequest } from './unifiedAgentPresentation';

const state = (status: AgentUiState['status'], events: AgentUiState['events'] = []): AgentUiState => ({
  status, model: 'test-model', goal: 'Create a drawing', result: '', events,
});

describe('unified agent renderer presentation', () => {
  it('allows stopping a working task but not starting another', () => {
    expect(presentUnifiedAgent(state('working'))).toMatchObject({busy:true,canRun:false,canStop:true,canResume:false});
  });
  it('offers resume only when paused', () => {
    expect(presentUnifiedAgent(state('paused'))).toMatchObject({canRun:true,canStop:false,canResume:true});
    expect(presentUnifiedAgent(state('limit'))).toMatchObject({canRun:true,canStop:false,canResume:true});
    expect(presentUnifiedAgent(state('completed')).canResume).toBe(false);
  });
  it('never leaks event payloads or unsafe tool names into activity labels', () => {
    const view = presentUnifiedAgent(state('working', [
      {kind:'tool',tool:'app_command',text:'{"apiKey":"SECRET"}'},
      {kind:'result',tool:'../../secret',text:'raw private file content',isError:true},
      {kind:'model',text:'hidden model response'},
    ]));
    expect(view.activities).toEqual([
      {kind:'tool',label:'Running app_command',failed:false},
      {kind:'result',label:'tool: failed',failed:true},
    ]);
    expect(JSON.stringify(view.activities)).not.toMatch(/SECRET|private|\.\.\//);
  });
  it('caps the activity timeline at fifty entries', () => {
    const events = Array.from({length:75}, () => ({kind:'stop' as const,text:'stopped'}));
    expect(presentUnifiedAgent(state('completed', events)).activities).toHaveLength(50);
  });
  it('matches existing IPC input constraints', () => {
    expect(validateUnifiedAgentRequest('  ', 'model')).toBeTruthy();
    expect(validateUnifiedAgentRequest('x'.repeat(4001),'model')).toBeTruthy();
    expect(validateUnifiedAgentRequest('task','')).toBeTruthy();
    expect(validateUnifiedAgentRequest('task','gpt-4.1-mini')).toBeNull();
  });
});
