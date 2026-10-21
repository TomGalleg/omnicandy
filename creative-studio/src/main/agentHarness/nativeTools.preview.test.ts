import { describe, expect, it, vi } from 'vitest';
import { nativeToolRegistry } from './nativeTools';
import type { LiveTaskController } from '../liveTask';
import type { ProjectStore } from '../projectStore';

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
function fixture() {
  const ctl = {
    snapshot: () => ({ collab: { phase: 'idle', lockOwner: null }, asset: null, history: [], savedVersionIds: [] }),
    open: vi.fn(async () => undefined),
    preview: vi.fn(async () => png),
  } as unknown as LiveTaskController;
  return { ctl, store: {} as ProjectStore };
}
describe('new-document and visual preview tools', () => {
  it('offers new_document only with a creation callback and uses the existing controller to open', async () => {
    const {ctl,store} = fixture();
    expect(nativeToolRegistry(ctl,store).snapshot().some(x=>x.name==='new_document')).toBe(false);
    const createBlank = vi.fn(async () => ({id:'asset-1',name:'Test.docx'}));
    const registry = nativeToolRegistry(ctl,store,{createBlank});
    const result = await registry.call(registry.snapshot(),'new_document',{app:'wordcraft',name:'Test'});
    expect(result.isError).not.toBe(true);
    expect(createBlank).toHaveBeenCalledWith('wordcraft','Test');
    expect(ctl.open).toHaveBeenCalledWith('asset-1','wordcraft','claude');
  });
  it('rejects filmcraft before invoking the creation callback', async () => {
    const {ctl,store} = fixture();
    const createBlank = vi.fn(async () => ({id:'asset-1',name:'x'}));
    const registry = nativeToolRegistry(ctl,store,{createBlank});
    const result = await registry.call(registry.snapshot(),'new_document',{app:'filmcraft'});
    expect(result.isError).toBe(true);
    expect(createBlank).not.toHaveBeenCalled();
    expect(ctl.open).not.toHaveBeenCalled();
  });
  it('exposes preview only to vision providers and returns image data separately from text', async () => {
    const {ctl,store} = fixture();
    expect(nativeToolRegistry(ctl,store).snapshot().some(x=>x.name==='look_at_document')).toBe(false);
    const registry = nativeToolRegistry(ctl,store,{supportsVision:true});
    const result = await registry.call(registry.snapshot(),'look_at_document',{});
    expect(result.text).not.toContain('base64');
    expect(result.imageDataUrl).toBe(`data:image/png;base64,${png.toString('base64')}`);
  });
});
