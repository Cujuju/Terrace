import { describe, expect, it, vi } from 'vitest';
import type { InstancedMesh } from 'three';
import { createHazeDeck, HAZE_DECK_DRAW_OBJECTS } from '../src/plugins/kit/hazeDeck.ts';
import { HAZE_LAYERS } from '../src/plugins/kit/hazeBank.ts';
import { DISC_RENDER_ORDER } from '../src/plugins/kit/discRig.ts';
import { countDrawObjects } from '../src/plugins/host.ts';

const disc = (intensity: number) => ({ id: 1, x: 2, y: 3, radius: 4, intensity, vx: 0, vy: 0 });

function deckOf(maxMasses: number) {
  const applyRevealClip = vi.fn();
  const deck = createHazeDeck({ maxMasses, strength: 1, name: 'demo', applyRevealClip });
  return { deck, applyRevealClip, mesh: deck.object as InstancedMesh };
}

describe('createHazeDeck', () => {
  it('holds every layer of every mass as one instance each, tiled slot-major', () => {
    const { mesh } = deckOf(2);
    const layers = HAZE_LAYERS.length;
    expect(mesh.count).toBe(2 * layers);
    const slots = Array.from(mesh.geometry.getAttribute('aSlot').array as Float32Array);
    const layerIndex = Array.from(mesh.geometry.getAttribute('aLayer').array as Float32Array);
    expect(slots).toEqual([...Array(layers).fill(0), ...Array(layers).fill(1)]);
    expect(layerIndex).toEqual([...Array(layers).keys(), ...Array(layers).keys()]);
  });

  it('is one draw object, clipped once, at the disc render order, with no normals', () => {
    const { deck, mesh, applyRevealClip } = deckOf(1);
    expect(applyRevealClip).toHaveBeenCalledTimes(1);
    expect(mesh.renderOrder).toBe(DISC_RENDER_ORDER);
    expect(mesh.geometry.getAttribute('normal')).toBeUndefined();
    expect(mesh.geometry.getAttribute('color').itemSize).toBe(4);
    expect(countDrawObjects(mesh)).toBe(0);
    deck.update(deck.claimSlot(), disc(1), 0);
    expect(countDrawObjects(mesh)).toBe(HAZE_DECK_DRAW_OBJECTS);
  });

  it('claims slots up to the ceiling and shows the mesh only while a slot is lit', () => {
    const { deck, mesh } = deckOf(1);
    const slot = deck.claimSlot();
    expect(deck.claimSlot()).toBe(-1);
    deck.update(-1, disc(1), 0);
    expect(mesh.visible).toBe(false);
    deck.update(slot, disc(0.5), 1);
    expect(mesh.visible).toBe(true);
    deck.park(slot);
    expect(mesh.visible).toBe(false);
  });
});
