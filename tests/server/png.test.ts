// The PNG reader behind ComfyUI masks reads pictures the way Pillow does (the skill's upload script uses Pillow), and
// the masks it writes read back the same.
import { describe, expect, it } from 'vitest';
import { decodePng, encodeAlphaPng, pngSize } from '../../server/png.ts';
import { maskPng } from '../../server/comfyui.ts';

// Made with Pillow 12.3: a random 7x5 RGB picture (rows filtered 0, 1, 0, 0, 2), and a 2-bit palette one with colour 1
// transparent. grey and alpha are what Pillow's convert("L") and convert("RGBA") give for them.
const RGB = 'iVBORw0KGgoAAAANSUhEUgAAAAcAAAAFCAIAAAAG+GGPAAAAeUlEQVR4nAFuAJH/AKVNyhglMLsdbRMs3tYjey7ZHj9yHwHLGXFMKyO/BajHE/jDYv3AYDjevDcA7ui5mX9cfCmZ/a/lkyU81lSvTfrXABQnoK6z/ukjL4ryIR+e5JHFsQvstQJCFFxwvJVZW5w+DAg2R+n9gSuD6AK8yjMk3dFSEwAAAABJRU5ErkJggg==';
const RGB_GREY = [118, 34, 85, 57, 99, 145, 89, 88, 64, 114, 107, 146, 39, 222, 228, 131, 79, 204, 73, 133, 194, 47, 186, 96, 187, 128, 179, 162, 89, 91, 117, 214, 183, 109, 188];
const PAL = 'iVBORw0KGgoAAAANSUhEUgAAAAcAAAAFAgMAAAD09B5LAAAADFBMVEWG5Y1slJrBNmk7MaQojMOHAAAAAnRSTlP/AOW3MEoAAAAXSURBVHicY6zmZNhlwCCzgOGGA5PMBwAc0QRSeT43+AAAAABJRU5ErkJggg==';
const PAL_GREY = [137, 65, 101, 65, 101, 191, 137, 101, 65, 101, 101, 191, 65, 191, 191, 137, 65, 191, 101, 101, 191, 65, 137, 101, 191, 137, 191, 191, 65, 65, 137, 191, 191, 65, 191];
const PAL_ALPHA = [0, 255, 255, 255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 0, 255, 255, 0, 255, 255, 255, 255, 0, 255, 255, 255, 255];

describe('reading PNG pictures', () => {
  it('gives the grey levels and transparency Pillow gives', () => {
    const rgb = decodePng(Buffer.from(RGB, 'base64'));
    expect([rgb.width, rgb.height, rgb.hasAlpha]).toEqual([7, 5, false]);
    expect([...rgb.grey]).toEqual(RGB_GREY);
    expect([...rgb.alpha].every((a) => a === 255)).toBe(true);
    const pal = decodePng(Buffer.from(PAL, 'base64'));
    expect(pal.hasAlpha).toBe(true);
    expect([...pal.grey]).toEqual(PAL_GREY);
    expect([...pal.alpha]).toEqual(PAL_ALPHA);
    expect(pngSize(Buffer.from(PAL, 'base64'))).toEqual({ width: 7, height: 5 });
  });

  it('writes masks that read back the same, and refuses what it cannot read', () => {
    const alpha = Uint8Array.from({ length: 35 }, (_, i) => (i * 37) & 255);
    expect([...decodePng(encodeAlphaPng(7, 5, alpha)).alpha]).toEqual([...alpha]);
    const interlaced = Buffer.from(RGB, 'base64');
    interlaced[28] = 1; // IHDR's interlace byte
    expect(() => decodePng(interlaced)).toThrow(/interlaced/);
    expect(() => maskPng(Buffer.from('GIF89a'), 'white', 'mask.gif')).toThrow(/has to be a PNG/);
  });

  it("takes a mask's own transparency when told to, and wants one there", () => {
    // the palette picture's transparent pixels are the area
    expect([...decodePng(maskPng(Buffer.from(PAL, 'base64'), 'transparent', 'm.png').png).alpha]).toEqual(PAL_ALPHA);
    expect(() => maskPng(Buffer.from(RGB, 'base64'), 'transparent', 'm.png')).toThrow(/has no transparency/);
  });
});
