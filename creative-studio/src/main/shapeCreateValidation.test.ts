import { describe, expect, it } from 'vitest';
import { checkPhotoCraftOp } from '@shared/photocraftOps';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppOperation } from '@shared/contracts';
import { LiveTaskController } from './liveTask';
import { preflightNativeCommand } from './nativeCommandPreflight';
import type { LiveDoc } from './photocraftLive';
import { ProjectStore } from './projectStore';

// shape.create as PhotoCraft reports it (photocraft-cli commands --json): no field is marked optional;
// "kind" picks which of rect / from+to / path applies.
const SHAPE_CREATE_PARAMS = "{\"kind\":\"rect|roundedRect|ellipse|polygon|star|line|path\"=\"rect\",\"rect\":[x,y,w,h] (rect/roundedRect/ellipse/polygon/star),\"radii\":[tl,tr,br,bl]|r (roundedRect=10),\"sides\":3..100=5,\"starRatio\":0..1 (star=0.5),\"from\":[x,y],\"to\":[x,y],\"weight\":px=1 (line),\"path\":{…} (kind path),\"fill\":\"#rrggbb\"|[r,g,b,a]|{\"gradient\":{\"stops\":[[t,\"#hex\"]],\"angle\":deg,\"scale\":%,\"style\":\"linear|radial|angle|reflected|diamond\",\"reverse\":bool}}|{\"pattern\":name}|null (no fill)=foreground,\"stroke\":{\"width\":px,\"color\":\"#rrggbb\"|fill,\"opacity\":0..100,\"align\":\"inside|center|outside\",\"cap\":\"butt|round|square\",\"join\":\"miter|round|bevel\",\"miterLimit\":n,\"dashes\":[multiples of width],\"dashOffset\":n}|null=none,\"name\":str?,\"addTo\":layerId? + \"op\":\"combine|subtract|intersect|exclude\" (append to an existing shape layer)} → shape.info. path: {\"subpaths\":[{\"closed\":bool=true,\"op\":\"combine|subtract|intersect|exclude\",\"knots\":[[x,y] | {\"anchor\":[x,y],\"in\":[x,y],\"out\":[x,y],\"smooth\":bool}]}],\"fillRule\":\"nonzero|evenodd\",\"inverted\":bool}";
const detail = JSON.stringify({ id: 'shape.create', label: 'New Shape Layer', params: SHAPE_CREATE_PARAMS });
const preflight = (params: Record<string, unknown>) => preflightNativeCommand(detail, 'shape.create', params);
const policy = (params: Record<string, unknown>) => checkPhotoCraftOp('shape.create', params);
const drawn = { subpaths: [{ closed: true, knots: [[0, 0], { anchor: [10, 0], in: [5, 0], out: [15, 0], smooth: true }, [10, 10]] }], fillRule: 'nonzero' };

describe('PhotoCraft shape.create: schema and security policy agree', () => {
  it('accepts valid ellipse, line and drawn-path parameters at both layers', () => {
    const ellipse = { kind: 'ellipse', rect: [100, 100, 200, 150], fill: '#ff0000' };
    const line = { kind: 'line', from: [0, 0], to: [100, 100], weight: 3 };
    const path = { kind: 'path', path: drawn, fill: '#00ff00' };
    for (const p of [ellipse, line, path]) {
      expect(preflight(p).status, JSON.stringify(p)).not.toBe('rejected');
      expect(policy(p).ok, JSON.stringify(p)).toBe(true);
    }
    // No field of a discriminated command is required on its own: the engine enforces what the kind needs.
    expect(preflight({ kind: 'ellipse', rect: [1, 2, 3, 4] }).status).toBe('validated');
    expect(preflight({ kind: 'line', from: [0, 0], to: [1, 1] }).status).toBe('validated');
  });

  it('still rejects invalid parameters', () => {
    expect(preflight({ kind: 'blob', rect: [0, 0, 1, 1] })).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/must be one of/) });
    expect(preflight({ kind: 'ellipse', rect: [0, 0, 1, 1], bogus: 1 })).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/Unknown parameter "bogus"/) });
    expect(preflight({ kind: 'polygon', rect: [0, 0, 1, 1], sides: 500 })).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/at most 100/) });
  });

  it('keeps filesystem paths blocked, including inside a drawn path', () => {
    expect(policy({ kind: 'rect', rect: [0, 0, 1, 1], path: 'C:/Users/x/a.png' }).ok).toBe(false);
    expect(policy({ kind: 'path', path: '../secret.svg' }).ok).toBe(false);
    expect(policy({ kind: 'path', path: ['a'] }).ok).toBe(false);
    expect(policy({ kind: 'path', path: { file: 'C:/Users/x/a.svg' } }).ok).toBe(false);
    expect(policy({ kind: 'path', path: { subpaths: [{ knots: [[0, 0]], note: 'C:\\Users\\x' }] } }).ok).toBe(false);
    expect(policy({ kind: 'rect', rect: [0, 0, 1, 1], source: 'a.png' }).ok).toBe(false);
  });
});

class Doc implements LiveDoc {
  ran: string[] = [];
  async open() { return { name: 'x' }; }
  async run(op: AppOperation) { this.ran.push(op.command); }
  async history() { return ['Open', ...this.ran]; }
  async writeVersion(dir: string, base: string) { const main = path.join(dir, base + '.png'); await fs.writeFile(main, 'x'); return { main }; }
  async listCommands() { return detail; }
}

describe('LiveTaskController PhotoCraft shape.create end to end (mocked app)', () => {
  it('runs a filled ellipse, and refuses bad values and filesystem paths before the app is touched', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'shape-'));
    try {
      const store = new ProjectStore(path.join(tmp, 'p')); await store.create('t');
      const id = (await store.importFile(path.resolve(__dirname, '../../fixtures/sample-project/photocraft-smoke.png'))).asset.id;
      const doc = new Doc();
      const ctl = new LiveTaskController({ connect: async () => doc, store, emit: () => {},
        writeDir: async () => { const d = path.join(store.root, 'w'); await fs.mkdir(d, { recursive: true }); return d; } });
      await ctl.open(id, 'photocraft', 'claude');
      const ok = await ctl.claudeAppCommand('shape.create', { kind: 'ellipse', rect: [10, 10, 80, 80], fill: '#ff0000' });
      expect(ok).toMatch(/applied/);
      expect(doc.ran).toEqual(['shape.create']);
      await expect(ctl.claudeAppCommand('shape.create', { kind: 'polygon', rect: [0, 0, 1, 1], sides: 500 })).rejects.toThrow(/at most 100/);
      await expect(ctl.claudeAppCommand('shape.create', { kind: 'path', path: 'C:/Users/x/a.svg' })).rejects.toThrow(/not allowed/);
      expect(doc.ran).toEqual(['shape.create']);
    } finally { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}); }
  });
});
