import { forEachFootprintOffset } from '@terrace/shared';

export const BEDROCK_WARD_SECONDS = 15;

export const WARD_NOTICE_INTERVAL_S = 1;

interface Ward {
  readonly owner: string;
  remainingS: number;
}

const wards = new Map<number, Ward>();

const noticeSilenceS = new Map<string, number>();

export function stampWard(
  size: number,
  owner: string,
  x: number,
  y: number,
  radius: number,
): void {
  forEachFootprintOffset(radius, (dx, dy) => {
    const cx = x + dx;
    const cy = y + dy;
    if (cx < 0 || cy < 0 || cx >= size || cy >= size) return;
    wards.set(cy * size + cx, { owner, remainingS: BEDROCK_WARD_SECONDS });
  });
}

export function wardHolderAgainst(
  size: number,
  actor: string,
  x: number,
  y: number,
  radius: number,
): string | null {
  let holder: string | null = null;
  forEachFootprintOffset(radius, (dx, dy) => {
    if (holder !== null) return;
    const cx = x + dx;
    const cy = y + dy;
    if (cx < 0 || cy < 0 || cx >= size || cy >= size) return;
    const ward = wards.get(cy * size + cx);
    if (ward !== undefined && ward.owner !== actor) holder = ward.owner;
  });
  return holder;
}

export function sweepWards(dt: number): void {
  for (const [cell, ward] of wards) {
    ward.remainingS -= dt;
    if (ward.remainingS <= 0) wards.delete(cell);
  }
  for (const [session, remaining] of noticeSilenceS) {
    const next = remaining - dt;
    if (next <= 0) noticeSilenceS.delete(session);
    else noticeSilenceS.set(session, next);
  }
}

export function claimWardNotice(sessionId: string): boolean {
  if (noticeSilenceS.has(sessionId)) return false;
  noticeSilenceS.set(sessionId, WARD_NOTICE_INTERVAL_S);
  return true;
}

export function dropWardsOf(owner: string): void {
  for (const [cell, ward] of wards) {
    if (ward.owner === owner) wards.delete(cell);
  }
  noticeSilenceS.delete(owner);
}

export function wardedCellCount(): number {
  return wards.size;
}

export function resetWards(): void {
  wards.clear();
  noticeSilenceS.clear();
}
