import { describe, expect, it } from 'vitest';
import { EmbeddedApp } from '../embeddedApp';

describe('window embedding by system', () => {
  it('is supported on Windows only', () => {
    expect(new EmbeddedApp(() => null, 'x.ps1', () => undefined, 'win32').supported).toBe(true);
    expect(new EmbeddedApp(() => null, 'x.ps1', () => undefined, 'linux').supported).toBe(false);
  });
  it('on Linux every call is a safe no-op (no PowerShell tracker is ever started)', () => {
    const e = new EmbeddedApp(() => null, 'missing-tracker.ps1', () => undefined, 'linux');
    expect(() => { e.prewarm(); e.prepare(1234); e.attach(1234); e.setViewport({ x: 0, y: 0, width: 800, height: 600, visible: true }); e.apply(); e.popOut(); e.popIn(); e.release(true); }).not.toThrow();
    expect(e.attachedPid).toBeNull();
  });
});
