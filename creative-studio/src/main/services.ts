// Honest stubs for services that are not implemented yet. They report "unavailable" rather than
// pretending to work.

import type { CredentialStatus, CredentialVault, WindowCapture, WindowCaptureSource } from '@shared/contracts';

export class UnavailableWindowCapture implements WindowCapture {
  readonly available = false;
  async listSources(): Promise<WindowCaptureSource[]> { return []; }
  unavailableReason() {
    return 'Live window capture is not implemented yet (planned with the PhotoCraft vertical slice). No app window is being shown.';
  }
}

/** Phase 4 will back this with Electron safeStorage (Windows DPAPI) in the main process only. */
export class NotConfiguredCredentialVault implements CredentialVault {
  readonly available = false;
  async status(providerId: string): Promise<CredentialStatus> {
    return { providerId, configured: false, handle: null };
  }
}
