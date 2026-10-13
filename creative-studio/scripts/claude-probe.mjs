// One tiny Claude Agent SDK round trip: uses this PC's Claude Code login, no built-in tools,
// one in-process tool. Prints message types, tool calls and the result.
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const calls = [];
const ping = tool('ping', 'Replies pong. Call it exactly once with the word "hello".', { word: z.string() }, async ({ word }) => {
  calls.push(word);
  return { content: [{ type: 'text', text: `pong ${word}` }] };
});

const q = query({
  prompt: 'Call the ping tool once with "hello", then reply with just the tool result.',
  options: {
    model: 'claude-opus-5-5',
    tools: [],
    mcpServers: { cc: createSdkMcpServer({ name: 'cc', tools: [ping] }) },
    allowedTools: ['mcp__cc__ping'],
    permissionMode: 'dontAsk',
    settingSources: [],
    persistSession: false,
    maxTurns: 4,
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'createcraft-probe/0.1' },
  },
});
const types = [];
for await (const m of q) {
  types.push(m.type + (m.subtype ? `:${m.subtype}` : ''));
  if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'tool_use') console.log('tool_use', b.name, JSON.stringify(b.input));
  if (m.type === 'system' && m.subtype === 'init') console.log('init model', m.model, 'tools', JSON.stringify(m.tools), 'apiKeySource', m.apiKeySource);
  if (m.type === 'result') console.log('result', m.subtype, JSON.stringify(m.result ?? m.errors), 'cost', m.total_cost_usd);
}
console.log('types', [...new Set(types)].join(','), 'calls', calls);
