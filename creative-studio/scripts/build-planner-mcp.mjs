// Bundles the planner MCP server into one file (out/planner-mcp.cjs) that runs with plain Node or, in the installed app,
// with OmniCandi's own runtime (ELECTRON_RUN_AS_NODE=1). No other dependency is needed at run time.
import { build } from 'esbuild';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
await build({
  entryPoints: [path.join(root, 'src/main/planner/mcpMain.ts')],
  outfile: path.join(root, 'out/planner-mcp.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'warning',
  alias: { '@shared': path.join(root, 'src/shared') },
});
console.log('built out/planner-mcp.cjs');
