// Reactive state shared between the plugin's attach wiring and its HUD panel.
// Module-scope signals for the same reason as client/src/state/hudState.ts:
// the imperative half writes them from outside any reactive root.

import { createSignal } from 'solid-js';

/** SHARE_URL as the server sent it; null = server has none configured. */
const [serverShareUrl, setServerShareUrl] = createSignal<string | null>(null);

/** Flipped briefly after a copy so the button can acknowledge the click. */
const [justCopied, setJustCopied] = createSignal(false);

export { serverShareUrl, setServerShareUrl, justCopied, setJustCopied };
