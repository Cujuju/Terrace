// Is this event's target somewhere the player is TYPING? Every bare-key
// shortcut in this repo has to ask, or it eats the character instead.

/** True for inputs, textareas, selects and any contenteditable element. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
