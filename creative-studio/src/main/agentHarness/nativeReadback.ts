/**
 * Native commands whose structured result may be used as read-back evidence. Each one must be a command the real
 * app permits (see the permission check in shared/photocraftOps.ts); `document.inspect` is deliberately absent because
 * PhotoCraft's policy refuses it ("not allowed"), so it can never produce evidence.
 */
export const NATIVE_READBACK_COMMANDS: ReadonlySet<string> = new Set(['shape.info', 'layer.list']);
