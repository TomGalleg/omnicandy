// What OmniCandy can honestly say about each AI client and the planner connection. Three words only:
//   verified     - a real client of that kind was connected to the real planner server in this repository's tests
//   untested     - implemented from the client's documentation, never run against the real client
//   unavailable  - the client cannot reach this kind of connection (stated by its documentation)
// Checked against current documentation on 2026-10-16. Third-party summaries are marked; re-check before relying on them.

export type ClientStatus = 'verified' | 'untested' | 'unavailable';
export interface PlannerClient {
  id: string; name: string; status: ClientStatus; how: string; evidence: string; limits: string; source: string;
}

export const PLANNER_CLIENTS: PlannerClient[] = [
  {
    id: 'claude-code', name: 'Claude Code', status: 'verified', how: 'Local stdio server (claude mcp add ... -- <command>). Also accepts HTTP servers with a bearer header.',
    evidence: 'Claude Code\'s own "claude mcp list" health check started the planner server and reported it Connected (isolated config, no model call). Tool listing and a full claim/report/review round trip are covered by the MCP tests with OmniCandy\'s MCP client.',
    limits: 'A model-driven session (Claude Code deciding to call the tools) was not run: it would be a paid call.', source: 'code.claude.com/docs/en/mcp (official)',
  },
  {
    id: 'cowork', name: 'Claude Cowork', status: 'unavailable', how: 'Cowork uses remote connectors hosted by Anthropic; local stdio servers configured in Claude Desktop apply to Claude Desktop only.',
    evidence: 'Not run.', limits: 'The local planner server is not reachable from Cowork. Use copy and paste (Markdown package out, JSON or Markdown report in). A remote HTTPS connector would be your own hosting choice and is not set up by OmniCandy.',
    source: 'Third-party setup guides (Boomi, Drio) found 2026-10-16; not confirmed in Anthropic\'s own pages',
  },
  {
    id: 'chatgpt', name: 'ChatGPT', status: 'unavailable', how: 'Custom connectors need a publicly reachable HTTPS MCP server (Developer Mode; plan limits vary). Local stdio servers do not work.',
    evidence: 'Not run. The local HTTP mode (127.0.0.1, bearer token) is covered by tests but has never been put behind HTTPS or called by ChatGPT.',
    limits: 'Reaching it would need you to expose the server yourself (your own tunnel or host) and use ChatGPT\'s connector authentication. Copy and paste works today.', source: 'Third-party guides (Auth0, Zuplo, Boomi) found 2026-10-16; OpenAI\'s own page was not read',
  },
  {
    id: 'gemini-cli', name: 'Gemini CLI', status: 'untested', how: 'Local stdio server in ~/.gemini/settings.json under mcpServers (command, args, env).',
    evidence: 'The configuration snippet follows the documented shape. Gemini CLI is not installed here, so it was not run.', limits: 'Unverified against the real client.', source: 'geminiCLI.com docs and third-party guides found 2026-10-16',
  },
  {
    id: 'gemini-app', name: 'Gemini app', status: 'unavailable', how: 'Custom apps accept a remote MCP server URL only (reported as available since mid-2026, personal accounts, web, English).',
    evidence: 'Not run.', limits: 'A local server cannot be added. Use copy and paste.', source: 'Third-party summaries only; Google\'s own documentation was not confirmed',
  },
  {
    id: 'createcraft', name: 'OmniCandy\'s own Claude', status: 'untested', how: 'Built-in tools in the Claude panel (planner_packages, planner_get_package, planner_claim, planner_report), the same rules as the MCP server.',
    evidence: 'The tool handlers are tested offline against the real service. A live Claude session using them was not run (it would be a paid call).', limits: 'It only retrieves and reports on a package when you ask it to; it never starts by itself.', source: 'This repository',
  },
];
