import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { coreVersionStamp } from '../src/core-version.ts';
import { makeTempRoot, removeTempRoot } from './support/tempRoot.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(removeTempRoot));

it('stamps actual core/shared bytes consistently, including edits and reverts without git', () => {
  const root = makeTempRoot('terrace-core-stamp-');
  roots.push(root);
  for (const directory of ['server/src', 'shared/src']) mkdirSync(join(root, directory), { recursive: true });
  const server = join(root, 'server/src/index.ts');
  writeFileSync(server, 'export const value = 1;');
  const initial = coreVersionStamp(root);
  expect(coreVersionStamp(root)).toBe(initial);
  writeFileSync(server, 'export const value = 2;');
  expect(coreVersionStamp(root)).not.toBe(initial);
  writeFileSync(server, 'export const value = 1;');
  expect(coreVersionStamp(root)).toBe(initial);
  writeFileSync(join(root, 'shared/src/math.ts'), 'export const step = 3;');
  expect(coreVersionStamp(root)).not.toBe(initial);
});
