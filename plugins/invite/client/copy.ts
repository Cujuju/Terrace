// Clipboard write for the invite panel's Copy button, split out of
// InvitePanel.tsx so it is importable — and testable — without a Solid JSX
// transform, the same reason derive.ts is its own module.

import { setJustCopied } from './state.ts';

/** How long the Copy button acknowledges a click before reverting. */
export const COPIED_FLASH_MS = 1500;

/**
 * The pending "revert the Copied flash" timer, if a click is still within its
 * COPIED_FLASH_MS window. Cleared and replaced on every click so a rapid
 * double-click can't let an earlier click's timer revert the flash early.
 */
let copiedFlashTimeout: ReturnType<typeof setTimeout> | undefined;

export function copy(url: string): void {
  // Clipboard access needs a secure context or localhost; over plain LAN http
  // the API is absent. Selecting-and-copying by hand still works — the URL is
  // rendered as text — so failure here is silently tolerated.
  void navigator.clipboard
    ?.writeText(url)
    .then(() => {
      setJustCopied(true);
      clearTimeout(copiedFlashTimeout);
      copiedFlashTimeout = setTimeout(() => setJustCopied(false), COPIED_FLASH_MS);
    })
    .catch(() => {
      // Denied permission or a borderline-secure context: the comment above
      // already covers this — the URL is still visible and selectable, so
      // there is nothing to surface here.
    });
}
