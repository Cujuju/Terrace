import { setJustCopied } from './state.ts';

export const COPIED_FLASH_MS = 1500;

let copiedFlashTimeout: ReturnType<typeof setTimeout> | undefined;

export function copy(url: string): void {
  void navigator.clipboard
    ?.writeText(url)
    .then(() => {
      setJustCopied(true);
      clearTimeout(copiedFlashTimeout);
      copiedFlashTimeout = setTimeout(() => setJustCopied(false), COPIED_FLASH_MS);
    })
    .catch(() => {
    });
}
