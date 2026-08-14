// invite, driven through the REAL plugin host — the same harness the other
// plugin suites use — plus the pure client-side fallback logic.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { Player } from '../../../server/src/player.ts';
import {
  RecordingSink,
  asLoadedPlugin,
  worldWithUnlockedChunks,
} from '../../../server/test/support/harness.ts';
import { deriveLocalShareUrl } from '../client/derive.ts';
import { parseInviteInfoPayload } from '../protocol.ts';
import { SHARE_URL_ENV, plugin, resetInviteState } from '../server/index.ts';

const WORLD_SIZE = 64;
const PLAYER: Player = { id: 'session-1', name: 'Tester' };

function boot(): RecordingSink {
  resetInviteState();
  const world = worldWithUnlockedChunks(WORLD_SIZE, [[1, 1]]);
  const sink = new RecordingSink();
  world.setSink(sink);
  const host = new PluginHost(world, [plugin].map(asLoadedPlugin));
  host.worldCreate();
  world.addPlayer(PLAYER);
  host.playerJoined(PLAYER);
  return sink;
}

/** The invite:info payloads sent to PLAYER, in order. */
function infoSentTo(sink: RecordingSink): unknown[] {
  return sink
    .ofType('invite:info')
    .filter((m) => m.target === PLAYER.id)
    .map((m) => m.payload);
}

describe('invite server half', () => {
  const originalEnv = process.env[SHARE_URL_ENV];

  beforeEach(() => {
    delete process.env[SHARE_URL_ENV];
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[SHARE_URL_ENV];
    else process.env[SHARE_URL_ENV] = originalEnv;
    resetInviteState();
  });

  it('sends the configured SHARE_URL to a joining player, trimmed', () => {
    process.env[SHARE_URL_ENV] = '  http://amd.local:5173  ';
    const sink = boot();
    expect(infoSentTo(sink)).toEqual([{ shareUrl: 'http://amd.local:5173' }]);
  });

  it('sends an explicit null when nothing is configured', () => {
    const sink = boot();
    expect(infoSentTo(sink)).toEqual([{ shareUrl: null }]);
  });

  it('treats a whitespace-only SHARE_URL as unconfigured', () => {
    process.env[SHARE_URL_ENV] = '   ';
    const sink = boot();
    expect(infoSentTo(sink)).toEqual([{ shareUrl: null }]);
  });
});

describe('protocol parse', () => {
  it('accepts a proper payload and degrades every malformed shape to null', () => {
    expect(parseInviteInfoPayload({ shareUrl: 'http://x:1' })).toEqual({
      shareUrl: 'http://x:1',
    });
    for (const bad of [null, 42, 'str', {}, { shareUrl: '' }, { shareUrl: 7 }]) {
      expect(parseInviteInfoPayload(bad)).toEqual({ shareUrl: null });
    }
  });
});

describe('client fallback derivation', () => {
  it('shares the page origin for a network visitor', () => {
    expect(deriveLocalShareUrl('192.168.3.46', 'http://192.168.3.46:5173')).toBe(
      'http://192.168.3.46:5173',
    );
    expect(deriveLocalShareUrl('amd.local', 'http://amd.local:5173')).toBe(
      'http://amd.local:5173',
    );
  });

  it('never shares a loopback address — it would point friends at themselves', () => {
    expect(deriveLocalShareUrl('localhost', 'http://localhost:5173')).toBeNull();
    expect(deriveLocalShareUrl('127.0.0.1', 'http://127.0.0.1:5173')).toBeNull();
    expect(deriveLocalShareUrl('[::1]', 'http://[::1]:5173')).toBeNull();
  });
});
