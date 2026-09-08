import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { plugin as manaPlugin } from '../../mana/server/index.ts';
import { plugin as revealPlugin } from '../server/index.ts';

const PLUGINS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const shippedDirectories = (): string[] =>
  readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

describe('the example plugins as shipped', () => {
  it("names each plugin after its own directory", () => {
    const directories = shippedDirectories();
    expect(directories).toContain('mana');
    expect(directories).toContain('reveal');
    expect(manaPlugin.name).toBe('mana');
    expect(revealPlugin.name).toBe('reveal');
  });

  it('loads mana before reveal, so the land is charged for before it is granted', () => {
    const directories = shippedDirectories();
    expect(directories.indexOf('mana')).toBeLessThan(directories.indexOf('reveal'));
  });

  it('keeps reveal stateless', () => {
    expect(revealPlugin.persistence).toBeUndefined();
  });
});
