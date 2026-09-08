export const INVITE_PLUGIN_NAME = 'invite';

export const INVITE_INFO_MESSAGE = 'info';

export interface InviteInfoMessage {
  readonly shareUrl: string | null;
}

export function parseInviteInfoPayload(payload: unknown): InviteInfoMessage {
  if (typeof payload !== 'object' || payload === null) return { shareUrl: null };
  const url = (payload as { shareUrl?: unknown }).shareUrl;
  return { shareUrl: typeof url === 'string' && url.length > 0 ? url : null };
}
