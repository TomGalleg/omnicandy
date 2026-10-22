import { describe, expect, it } from 'vitest';
import type { AgentUiState } from './agentHarness';
import { explainFailure, presentUnifiedAgent, validateUnifiedAgentRequest } from './unifiedAgentPresentation';

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
  it('explains failures in fixed plain words, never with the raw tool output', () => {
    const view = presentUnifiedAgent(state('limit', [
      {kind:'tool',tool:'external_commands',text:'{}'},
      {kind:'result',tool:'external_commands',text:'Error: Blender is not connected (status: available; Ready to connect.). Stop and wait for the user to reconnect it.',isError:true},
      {kind:'result',tool:'external_command',text:'Error: validation (invalid-params): C:/Users/me/secret-plan.blend is not in the Blender folder',isError:true},
      {kind:'stop',text:'paused'},
    ]));
    expect(view.activities[1]).toMatchObject({failed:true,reason:expect.stringMatching(/not connected.*Software list/)});
    expect(view.activities[2]).toMatchObject({reason:'A command was refused because its settings were not valid.'});
    expect(view.latestProblem).toBe('A command was refused because its settings were not valid.');
    expect(view.now).toBe('Agent stopped');
    expect(JSON.stringify(view)).not.toMatch(/secret-plan|Users[\\/]me/);
    expect(explainFailure('raw private file content')).toBeUndefined();
    expect(explainFailure('Error: Identical tool call already failed twice. Stop retrying')).toMatch(/repeated a failing call/);
    expect(explainFailure('Error: Previous external_command (scene.build) returned an uncertain result. Further edits remain blocked')).toMatch(/recovery lock/);
  });
  it('keeps the AI own last words so a stop is explained, but not its internal deferral notes', () => {
    const view = presentUnifiedAgent(state('limit', [
      {kind:'model',text:'I will add the roofs next. Shall I use blue tiles?'},
      {kind:'model',text:'Final response deferred: structured plan still contains unfinished steps.'},
    ]));
    expect(view.lastModelText).toBe('I will add the roofs next. Shall I use blue tiles?');
    expect(presentUnifiedAgent(state('limit', [])).lastModelText).toBeUndefined();
  });
  it('names the setting a refused command got wrong (an identifier only, never a value)', () => {
    expect(explainFailure('Error: validation: Unknown parameter "radius" for object.add. Allowed: file_name, type, size')).toBe('A command was refused because its settings were not valid (Unknown parameter "radius").');
    expect(explainFailure('Error: validation: Missing required parameter "file_name" for scene.build.')).toMatch(/(Missing required parameter "file_name")/);
    expect(explainFailure('Error: invalid-params: "size" must be a number. secret-value-123')).toBe('A command was refused because its settings were not valid ("size" must be a number).'); // the value that follows is never echoed
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
