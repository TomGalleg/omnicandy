import { describe, expect, it } from 'vitest';
import { kindForExtension, sniffMedia } from './media';

describe('media sniffing', () => {
  it('maps extensions to asset kinds', () => {
    expect(kindForExtension('PNG')).toBe('image');
    expect(kindForExtension('.svg')).toBe('vector');
    expect(kindForExtension('mp4')).toBe('video');
    expect(kindForExtension('pcraft')).toBe('project');
    expect(kindForExtension('exe')).toBeNull();
  });

  it('reads SVG size from width/height or viewBox', () => {
    expect(sniffMedia('svg', Buffer.from('<svg width="120" height="80"></svg>'))).toEqual({ width: 120, height: 80 });
    expect(sniffMedia('svg', Buffer.from('<svg viewBox="0 0 300 150"></svg>'))).toEqual({ width: 300, height: 150 });
  });

  it('reads JPEG SOF dimensions and tolerates garbage', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03]);
    expect(sniffMedia('jpg', jpeg)).toEqual({ width: 640, height: 480 });
    expect(sniffMedia('png', Buffer.from('not a png'))).toEqual({});
    expect(sniffMedia('wav', Buffer.alloc(10))).toEqual({});
  });
});
