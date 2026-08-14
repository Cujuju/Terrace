// invite — wire contract shared by both halves.
//
// One message, server → client, sent once per join: the address the host wants
// players to share with friends. Null when the server has no SHARE_URL
// configured — the client then falls back to deriving one from its own page
// address (client/derive.ts).

export const INVITE_PLUGIN_NAME = 'invite';

/** Un-namespaced type of the server → client info push (`invite:info`). */
export const INVITE_INFO_MESSAGE = 'info';

export interface InviteInfoMessage {
  readonly shareUrl: string | null;
}

/** Defensive parse: any malformed payload degrades to "nothing configured". */
export function parseInviteInfoPayload(payload: unknown): InviteInfoMessage {
  if (typeof payload !== 'object' || payload === null) return { shareUrl: null };
  const url = (payload as { shareUrl?: unknown }).shareUrl;
  return { shareUrl: typeof url === 'string' && url.length > 0 ? url : null };
}
