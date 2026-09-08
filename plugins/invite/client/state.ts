import { createSignal } from 'solid-js';

const [serverShareUrl, setServerShareUrl] = createSignal<string | null>(null);

const [justCopied, setJustCopied] = createSignal(false);

export { serverShareUrl, setServerShareUrl, justCopied, setJustCopied };
