// Where the planner keeps its projects. Shared by the app and the stand-alone MCP server so both open the same folder.
import os from 'node:os';
import path from 'node:path';

export function defaultPlannerDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CREATECRAFT_PLANNER_DIR) return path.resolve(env.CREATECRAFT_PLANNER_DIR);
  const userData = env.CS_USER_DATA_DIR ? path.resolve(env.CS_USER_DATA_DIR)
    : process.platform === 'win32' ? path.join(env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'creative-studio')
      : path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'creative-studio');
  return path.join(userData, 'planner');
}
