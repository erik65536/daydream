/**
 * A built client's error stack, back in source terms. The build writes hidden source maps beside its bundles
 * (vite.config.ts); a frame such as `https://host/assets/index-3f2a.js:1:48213` becomes
 * `drawSprite (src/render/renderer.ts:431:9)`. Frames from elsewhere (the development client, browser extensions) are
 * left as they are.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SourceMap } from 'node:module';
import { CLIENT_DIST } from './paths.ts';

/** By bundle name; a build's bundles have new names, so a map once read stays right. */
const maps = new Map<string, SourceMap>();

function mapFor(bundle: string): SourceMap | null {
  if (maps.has(bundle)) return maps.get(bundle)!;
  try {
    const map = new SourceMap(JSON.parse(fs.readFileSync(path.join(CLIENT_DIST, 'assets', `${bundle}.map`), 'utf8')));
    maps.set(bundle, map);
    return map;
  } catch {
    return null; // no map for it (an old bundle, or a client not built here)
  }
}

/** Chrome's `at fn (url:line:col)` and Firefox's `fn@url:line:col` frames both end in `/assets/<bundle>.js:line:col`. */
const FRAME = /(?:https?:\/\/[^\s/]+)?\/assets\/([\w.-]+\.js):(\d+):(\d+)/g;

export function clientStack(stack: string): string {
  return stack.replace(FRAME, (whole, bundle: string, line: string, col: string) => {
    const origin = mapFor(bundle)?.findOrigin(Number(line), Number(col));
    if (!origin || !('fileName' in origin)) return whole;
    const file = origin.fileName.replace(/^.*?(?=src\/)/, '');
    return `${file}:${origin.lineNumber}:${origin.columnNumber}${origin.name ? ` [${origin.name}]` : ''}`;
  });
}
