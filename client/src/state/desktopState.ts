import { createSignal } from 'solid-js';
import type { DesktopBridge, DesktopState } from '../../electron/contract.ts';

/** The desktop shell's bridge (electron/preload.cjs); null in a browser. */
export const desktopBridge: DesktopBridge | null =
  (globalThis as { terraceDesktop?: DesktopBridge }).terraceDesktop ?? null;

const [desktopState, setDesktopState] = createSignal<DesktopState | null>(null);

/** What the shell lets this page see; null in a browser, and until the shell first answers. */
export { desktopState };

if (desktopBridge !== null) {
  void desktopBridge.invoke('state').then(setDesktopState);
  desktopBridge.onState(setDesktopState);
}

/** Electron wraps a rejected call's message in its own prefix; this is the part main wrote. */
export function desktopErrorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
}
