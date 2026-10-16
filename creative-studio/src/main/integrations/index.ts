import { blenderFactory } from './adapters/blender';
import { resolveFactory } from './adapters/resolve';
import { vendorStubs } from './adapters/vendors';
import { IntegrationManager, type ManagerDeps } from './manager';

export { IntegrationManager } from './manager';
export type { PermissionStore } from './manager';

/** The manager with every built-in adapter registered. Third-party adapters call manager.register(). */
export function createIntegrationManager(deps: ManagerDeps): IntegrationManager {
  const m = new IntegrationManager(deps);
  m.register(blenderFactory);
  m.register(resolveFactory);
  for (const s of vendorStubs) m.register(s);
  return m;
}
