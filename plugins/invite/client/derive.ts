// Pure fallback logic: what to show when the server has no SHARE_URL.
//
// A visitor who ALREADY reached the client over the network holds a perfectly
// shareable address in their own address bar — their page origin. The one case
// it is worthless is the hosting player's own browser, where the origin says
// localhost; sharing that would send friends to their own machines (the same
// trap client/src/config.ts documents for the ws endpoint).

/** Hostnames that mean "this very machine" and must never be shared. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * The page's own origin when it is shareable, else null. Pure so it is
 * testable: the caller passes location.hostname / location.origin.
 */
export function deriveLocalShareUrl(
  hostname: string,
  origin: string,
): string | null {
  return LOCAL_HOSTNAMES.has(hostname) ? null : origin;
}
