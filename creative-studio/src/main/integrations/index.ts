import { blenderFactory } from './adapters/blender';
import { resolveFactory } from './adapters/resolve';
import { unrealFactory } from './adapters/unreal';
import { vendorStubs } from './adapters/vendors';
import { IntegrationManager, type ManagerDeps } from './manager';

export { IntegrationManager } from './manager';
export type { PermissionStore } from './manager';
export { AdapterPackages } from './loader';

/** The manager with every built-in adapter registered. Installed packages are added by AdapterPackages. */
export function createIntegrationManager(deps: ManagerDeps): IntegrationManager {
  const m = new IntegrationManager(deps);
  m.register(blenderFactory, { builtin: true });
  m.register(resolveFactory, { builtin: true });
  m.register(unrealFactory, { builtin: true });
  for (const s of vendorStubs) m.register(s, { builtin: true });
  return m;
}
