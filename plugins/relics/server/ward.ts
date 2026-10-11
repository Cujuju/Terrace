import { forEachSweptCell, pointWithinSweep, type StrokeSweep } from '@terrace/shared';

export const BEDROCK_WARD_SECONDS = 15;

export const WARD_NOTICE_INTERVAL_S = 1;

interface Ward {
  readonly owner: string;
  remainingS: number;
}

const wards = new Map<number, Ward>();

const noticeSilenceS = new Map<string, number>();

export function stampWard(size: number, owner: string, sweep: StrokeSweep): void {
  forEachSweptCell(sweep, (cx, cy) => {
    if (cx < 0 || cy < 0 || cx >= size || cy >= size) return;
    wards.set(cy * size + cx, { owner, remainingS: BEDROCK_WARD_SECONDS });
  });
}

/** One closed-form test per standing ward, whatever shape the stroke swept. */
export function wardHolderAgainst(
  size: number,
  actor: string,
  sweep: StrokeSweep,
): string | null {
  for (const [cell, ward] of wards) {
    if (ward.owner === actor) continue;
    if (pointWithinSweep(sweep, cell % size, Math.floor(cell / size))) return ward.owner;
  }
  return null;
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
