// Bedrock Ward, proved through the REAL paths — the interceptor chain for a
// hand sculpt (server/src/intent/pipeline.ts) and handleCast for a relic cast.
// Run: node --experimental-strip-types plugins/relics/.verify-ward.mts

import { MAX_BRUSH_RADIUS } from '@terrace/shared';
import { handleSculptIntent } from '../../server/src/intent/pipeline.ts';
import { PluginHost } from '../../server/src/plugins/host.ts';
import type { Player } from '../../server/src/player.ts';
import { asLoadedPlugin, RecordingSink, worldWithUnlockedChunks } from '../../server/test/support/harness.ts';
import { CAST_MESSAGE, COLLECT_MESSAGE, type SkillId } from './protocol.ts';
import { currentRelics, plugin as relicsPlugin, resetRelicsState, cooldownOf } from './server/index.ts';
import { BEDROCK_WARD_SECONDS, wardedCellCount } from './server/ward.ts';

const SIZE = 64;
const TICK = 0.1;
const A: Player = { id: 'a', token: 't-a', name: 'Ada' };
const B: Player = { id: 'b', token: 't-b', name: 'Bo' };
const CELL = { x: 24, y: 24 };

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
}

const chunks: Array<readonly [number, number]> = [];
for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) chunks.push([cx, cy]);

resetRelicsState();
const world = worldWithUnlockedChunks(SIZE, chunks);
const sink = new RecordingSink();
world.setSink(sink);
const host = new PluginHost(world, [asLoadedPlugin(relicsPlugin)]);
host.worldCreate();
for (const player of [A, B]) {
  world.addPlayer(player);
  host.playerJoined(player);
}

function send(type: string, payload: unknown, player: Player): void {
  const entry = host.messageHandlers().find(([name]) => name === `relics:${type}`);
  entry?.[1](player, payload);
}
function collect(skill: SkillId, player: Player): void {
  const relic = currentRelics().find((r) => r.skill === skill);
  send(COLLECT_MESSAGE, { id: relic?.id }, player);
}
function sculpt(player: Player, x: number, y: number): boolean {
  return handleSculptIntent(
    { world, interceptors: host },
    player,
    { type: 'sculpt', x, y, radius: MAX_BRUSH_RADIUS, dir: 1 },
  ).applied;
}
function tick(seconds: number): void {
  for (let n = 0; n < Math.round(seconds / TICK); n++) host.tick(TICK);
}
function deniedTo(player: Player): number {
  return sink.messages.filter((m) => m.target === player.id && m.type === 'relics:denied').length;
}

// 1. No ward without the skill: an ordinary sculpt claims nothing.
sculpt(A, CELL.x, CELL.y);
check('a sculpt by a player without the skill wards nothing', wardedCellCount(), 0);

// 2. The holder's own stroke stamps its footprint.
collect('bedrock-ward', A);
check('A holds the ward', sculpt(A, CELL.x, CELL.y), true);
const warded = wardedCellCount();
check('the stroke warded its brush footprint', warded > 0 && warded < SIZE * SIZE, true);

// 3. The owner is never refused by their own ward; a stranger is.
check('the owner may keep working', sculpt(A, CELL.x, CELL.y), true);
const deniedBefore = deniedTo(B);
check('a stranger is refused', sculpt(B, CELL.x, CELL.y), false);
check('and is told why, once', deniedTo(B) - deniedBefore, 1);

// 4. The notice is throttled, not spammed, while the refusals keep coming.
for (let n = 0; n < 20; n++) sculpt(B, CELL.x, CELL.y);
check('twenty more refusals send no more notices', deniedTo(B) - deniedBefore, 1);

// 5. A relic cast is refused too — the path that never runs the chain.
collect('quake', B);
send(CAST_MESSAGE, { skill: 'quake', x: CELL.x, y: CELL.y }, B);
check('a cast onto warded ground starts no cooldown', cooldownOf(B.id, 'quake'), 0);
check('and it too says why', deniedTo(B) > deniedBefore, true);

// 5b. THE BOUNDARY, asserted rather than assumed: Bulwark's ring sits 32 cells
// out, so a cast centred on a ward never touches it — walling AROUND someone's
// ground is legal, because it moves none of it.
collect('bulwark', B);
send(CAST_MESSAGE, { skill: 'bulwark', x: CELL.x, y: CELL.y }, B);
check('a ring that only encircles the ward is allowed', cooldownOf(B.id, 'bulwark') > 0, true);

// 6. The window: still held just before it lapses, gone just after.
tick(BEDROCK_WARD_SECONDS - 1);
check(`still warded at ${BEDROCK_WARD_SECONDS - 1}s`, sculpt(B, CELL.x, CELL.y), false);
tick(2);
check(`free at ${BEDROCK_WARD_SECONDS + 1}s`, wardedCellCount(), 0);
check('and the stranger may now work it', sculpt(B, CELL.x, CELL.y), true);

// 7. A ward does not outlive its holder's connection.
sculpt(A, CELL.x, CELL.y);
check('A re-warded the ground', wardedCellCount() > 0, true);
host.playerLeft(A);
check('leaving drops the ward', wardedCellCount(), 0);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
