import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createResponseImageEmbedder } from "./response-images";

const roots: string[] = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0WQAAAAASUVORK5CYII=', 'base64');
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'buildwarden-response-images-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'image space.png'), png);
  return { root, workspace, embed: createResponseImageEmbedder(workspace) };
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('response images', () => {
  it('embeds relative, file and workspace sandbox image references with stable cached bytes', () => {
    const { workspace, embed } = fixture();
    for (const source of ['image%20space.png', '<image space.png>', pathToFileURL(join(workspace, 'image space.png')).href, 'sandbox:/image%20space.png']) {
      expect(embed(`![Preview](${source})`)).toBe(`![Preview](data:image/png;base64,${png.toString('base64')})`);
    }
    const saved = embed('![Preview](<image space.png>)');
    rmSync(join(workspace, 'image space.png'));
    expect(embed('![Preview](<image space.png>)')).toBe(saved);
  });
  it('rejects traversal, non-images, oversized images and junction escapes', () => {
    const { root, workspace, embed } = fixture();
    writeFileSync(join(root, 'outside.png'), png);
    writeFileSync(join(workspace, 'fake.png'), 'private text');
    writeFileSync(join(workspace, 'huge.png'), Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]));
    const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'image.png'), png);
    symlinkSync(outside, join(workspace, 'link'), 'junction');
    for (const source of ['../outside.png', 'fake.png', 'huge.png', 'link/image.png']) {
      expect(embed(`![Preview](${source})`)).toBe(`![Preview](${source})`);
    }
  });
  it('leaves code, unavailable images and network URLs untouched', () => {
    const { embed } = fixture();
    for (const text of ['```md\n![Example](<image space.png>)\n```', '`![Example](<image space.png>)`', '![Remote](https://example.com/a.png)', '![Missing](missing.png)']) expect(embed(text)).toBe(text);
  });
});
