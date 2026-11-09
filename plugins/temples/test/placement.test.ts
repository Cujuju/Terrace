import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BAND_HEIGHT, cellCentre } from '@terrace/shared';
import type { Player, WorldApi } from '../../../server/src/plugins/types.ts';
import { templeDoorCell, templeFootprintCells } from '../protocol.ts';
import { plugin, resetTemplesState, standingTemple } from '../server/index.ts';
import { resetPilgrimsBridge, type BridgedTempleSite } from '../server/pilgrims-bridge.ts';
import { resetStructuresBridge } from '../server/structures-bridge.ts';

const FIRST: Player = { id: 'first', token: 'first-token', name: 'First' };
const SECOND: Player = { id: 'second', token: 'second-token', name: 'Second' };
const SITE = { x: 100, y: 128 };
const BURST_REQUESTS = 1000;

function fixture() {
  const players = [FIRST, SECOND];
  const canDispatchSettler = vi.fn((_world: unknown, _site: BridgedTempleSite) => true);
  const setReservedStructureCells = vi.fn();
  const sendTo = vi.fn();
  const heightAt = vi.fn(() => BAND_HEIGHT * 10);
  const members = {
    worldSize: 256,
    heightAt,
    isCellUnlocked: () => true,
    players: () => players,
    broadcastVisible: vi.fn(),
    sendTo,
    emitEvent: vi.fn(),
    sibling: (name: string) => name === 'pilgrims'
      ? { canDispatchSettler } : { setReservedStructureCells },
  };
  const world = new Proxy({} as WorldApi, {
    get(_target, key) {
      if (Object.hasOwn(members, key)) return Reflect.get(members, key);
      throw new Error(`Unexpected WorldApi.${String(key)}`);
    },
  });
  plugin.onWorldCreate!(world);
  return { world, players, canDispatchSettler, setReservedStructureCells, sendTo, heightAt };
}

function replace(world: WorldApi, player: Player, cell = SITE): void {
  plugin.messages!.replace(world, player, cell);
}

describe('temple placement work admission', () => {
  beforeEach(() => { resetTemplesState(); resetPilgrimsBridge(); resetStructuresBridge(); });
  afterEach(() => { resetTemplesState(); resetPilgrimsBridge(); resetStructuresBridge(); });

  it('coalesces a player burst before terrain reads and runs one feasibility check per tick', () => {
    const { world, canDispatchSettler, heightAt } = fixture();
    for (let i = 0; i < BURST_REQUESTS; i++) replace(world, FIRST, { ...SITE, x: SITE.x + i % 2 });
    expect(heightAt).not.toHaveBeenCalled();
    expect(canDispatchSettler).not.toHaveBeenCalled();
    expect(standingTemple()).toBeNull();

    plugin.onTick!(world, 0.1);
    expect(canDispatchSettler).toHaveBeenCalledTimes(1);
    expect(standingTemple()).toMatchObject({ ...SITE, x: SITE.x + 1 });
    plugin.onTick!(world, 0.1);
    expect(canDispatchSettler).toHaveBeenCalledTimes(1);
  });

  it('retains FIFO position when coalescing and gives another player the next tick', () => {
    const { world, canDispatchSettler } = fixture();
    replace(world, FIRST, { ...SITE, x: 99 });
    replace(world, SECOND, { ...SITE, x: 80 });
    replace(world, FIRST);
    plugin.onTick!(world, 0.1);
    replace(world, FIRST, { ...SITE, x: 70 });
    plugin.onTick!(world, 0.1);
    expect(canDispatchSettler.mock.calls.map(([, site]) => site.x)).toEqual([100, 80]);
    plugin.onTick!(world, 0.1);
    expect(canDispatchSettler.mock.calls.map(([, site]) => site.x)).toEqual([100, 80, 70]);
  });

  it('rechecks current terrain when queued work runs', () => {
    const { world, canDispatchSettler, heightAt, sendTo } = fixture();
    replace(world, FIRST);
    heightAt.mockReturnValue(0);
    plugin.onTick!(world, 0.1);
    expect(canDispatchSettler).not.toHaveBeenCalled();
    expect(standingTemple()).toBeNull();
    expect(sendTo).toHaveBeenCalledWith(FIRST.id, 'refused', expect.anything());
  });

  it('keeps the current temple and its reservation when feasibility refuses a replacement', () => {
    const { world, canDispatchSettler, setReservedStructureCells } = fixture();
    replace(world, FIRST);
    plugin.onTick!(world, 0.1);
    canDispatchSettler.mockReturnValue(false);
    replace(world, FIRST, { ...SITE, x: 80 });
    plugin.onTick!(world, 0.1);
    expect(standingTemple()).toMatchObject(SITE);
    expect(setReservedStructureCells).toHaveBeenLastCalledWith(templeFootprintCells(SITE));
  });

  it('cancels queued work on removal, leave, close, and a fresh world', () => {
    const { world, canDispatchSettler } = fixture();
    replace(world, FIRST);
    replace(world, SECOND);
    plugin.messages!.remove(world, FIRST, {});
    plugin.onTick!(world, 0.1);
    replace(world, FIRST);
    plugin.onPlayerLeave!(world, FIRST);
    plugin.onTick!(world, 0.1);
    replace(world, SECOND);
    plugin.onWorldClose!(world);
    plugin.onWorldCreate!(world);
    plugin.onTick!(world, 0.1);
    replace(world, SECOND);
    plugin.onWorldCreate!(world);
    plugin.onTick!(world, 0.1);
    expect(canDispatchSettler).not.toHaveBeenCalled();
    expect(standingTemple()).toBeNull();
  });

  it('drops a disconnected player even when its leave hook was not delivered', () => {
    const { world, players, canDispatchSettler } = fixture();
    replace(world, FIRST);
    players.splice(0, 1);
    plugin.onTick!(world, 0.1);
    expect(canDispatchSettler).not.toHaveBeenCalled();
  });

  it('publishes a continuous door center without changing the grid anchor or footprint', () => {
    const { world, canDispatchSettler } = fixture();
    replace(world, FIRST);
    plugin.onTick!(world, 0.1);
    const door = cellCentre(templeDoorCell(SITE));
    const expected = { ...SITE, doorX: door.x, doorY: door.y };
    expect(canDispatchSettler.mock.calls[0]?.[0]).toBe(world);
    expect(canDispatchSettler.mock.calls[0]?.[1]).toEqual(expected);
    expect(standingTemple()).toEqual(expected);
    expect(Number.isInteger(templeDoorCell(SITE).x)).toBe(true);
  });
});
