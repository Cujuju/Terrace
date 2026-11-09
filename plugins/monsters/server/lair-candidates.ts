import { hashToIndex } from './rng.ts';

export const SUMMON_CANDIDATE_SAMPLE_CELLS = 64;

const CANDIDATE_REGION_MIX = 0x9e3779b1;
const CANDIDATE_RULE_MIX = 0x85ebca6b;

interface Replacement {
  readonly ordinal: number;
  readonly slot: number;
  readonly previous: number;
}

/** Reservoir ranks depend on the qualifying count; the tree resolves them to cells after point updates. */
export class LairCandidates {
  private readonly counts: Int32Array;
  private readonly ranks: number[] = [];
  private readonly replacements: Replacement[] = [];
  private count = 0;
  private readonly seedIndex: number;
  private readonly ruleIndex: number;

  constructor(
    seedIndex: number,
    ruleIndex: number,
    qualifies: Uint8Array,
  ) {
    this.seedIndex = seedIndex;
    this.ruleIndex = ruleIndex;
    this.counts = new Int32Array(qualifies.length + 1);
    for (let ordinal = 0; ordinal < qualifies.length; ordinal++) {
      if (qualifies[ordinal]) this.counts[ordinal + 1] = 1;
    }
    for (let node = 1; node < this.counts.length; node++) {
      const parent = node + (node & -node);
      if (parent < this.counts.length) this.counts[parent]! += this.counts[node]!;
    }
    this.resize(qualifies.reduce((sum, present) => sum + Number(present), 0));
  }

  get size(): number {
    return this.count;
  }

  update(ordinal: number, delta: -1 | 1): void {
    for (let node = ordinal + 1; node < this.counts.length; node += node & -node) {
      this.counts[node]! += delta;
    }
    this.resize(this.count + delta);
  }

  cells(order: Int32Array): number[] {
    return this.ranks.map((rank) => order[this.ordinalAtRank(rank)]!);
  }

  private resize(count: number): void {
    if (count < this.count) {
      while (this.replacements.length > 0) {
        const last = this.replacements[this.replacements.length - 1]!;
        if (last.ordinal < count) break;
        this.replacements.pop();
        this.ranks[last.slot] = last.previous;
      }
      this.ranks.length = Math.min(count, SUMMON_CANDIDATE_SAMPLE_CELLS);
    } else {
      for (let ordinal = this.count; ordinal < count; ordinal++) {
        if (ordinal < SUMMON_CANDIDATE_SAMPLE_CELLS) {
          this.ranks.push(ordinal);
          continue;
        }
        const seed = (Math.imul(this.seedIndex, CANDIDATE_REGION_MIX) ^
          Math.imul(this.ruleIndex + 1, CANDIDATE_RULE_MIX) ^ ordinal) | 0;
        const slot = hashToIndex(seed, ordinal + 1);
        if (slot >= SUMMON_CANDIDATE_SAMPLE_CELLS) continue;
        this.replacements.push({ ordinal, slot, previous: this.ranks[slot]! });
        this.ranks[slot] = ordinal;
      }
    }
    this.count = count;
  }

  private ordinalAtRank(rank: number): number {
    let node = 0;
    let remaining = rank + 1;
    let stride = 1;
    while (stride * 2 < this.counts.length) stride *= 2;
    for (; stride > 0; stride = Math.floor(stride / 2)) {
      const next = node + stride;
      if (next >= this.counts.length || this.counts[next]! >= remaining) continue;
      remaining -= this.counts[next]!;
      node = next;
    }
    return node;
  }
}
