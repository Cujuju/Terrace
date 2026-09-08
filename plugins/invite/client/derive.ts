const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function deriveLocalShareUrl(
  hostname: string,
  origin: string,
): string | null {
  return LOCAL_HOSTNAMES.has(hostname) ? null : origin;
}
