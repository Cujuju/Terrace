import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Test scratch lives in the checkout, not %TEMP%: leftovers are visible where
 * the work is, and one `.terrace-tmp` is cleanable in a single stroke.
 */
export const TEST_TMP_DIR = fileURLToPath(new URL('../../../.terrace-tmp/', import.meta.url));

/** `mkdtempSync` will not make the parent, so every caller makes it first. */
export function makeTempRoot(prefix: string): string {
  mkdirSync(TEST_TMP_DIR, { recursive: true });
  return mkdtempSync(`${TEST_TMP_DIR}${prefix}`);
}

/**
 * No retry: on Windows this throws EPERM while any handle under it is open, and
 * that refusal is the only signal a store or world was left unclosed.
 */
export function removeTempRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}
