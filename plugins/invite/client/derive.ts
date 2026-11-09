const LOCAL_HOSTNAMES = new Set(['localhost', '::1', '[::1]']);
const IPV4_OCTET_COUNT = 4;
const MAX_IPV4_OCTET = 255;
const IPV4_LOOPBACK_FIRST_OCTET = '127';

function isIpv4Loopback(hostname: string): boolean {
  const octets = hostname.split('.');
  return octets.length === IPV4_OCTET_COUNT && octets[0] === IPV4_LOOPBACK_FIRST_OCTET &&
    octets.every((octet) => /^\d+$/.test(octet) && Number(octet) <= MAX_IPV4_OCTET);
}

export function deriveLocalShareUrl(
  hostname: string,
  origin: string,
): string | null {
  return LOCAL_HOSTNAMES.has(hostname) || isIpv4Loopback(hostname) ? null : origin;
}
