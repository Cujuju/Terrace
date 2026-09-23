// Evaluated in the Terrace DEV page. Returns JSON-able results for one surface mode.
async (opts) => {
  const { world, connection } = window.__terrace;
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cap = await import('/src/terrain/capEmission.ts');
  const foot = await import('/src/terrain/faceFoot.ts');
  const CWS = 0.25;
  const CHUNK = 16;
  let seq = 1_000_000;
  const band = (x, y) => world.bandAtCell(x, y, null);
  const settle = async (maxMs = 60000, quietFrames = 20) => {
    const t0 = performance.now(); let quiet = 0;
    while (performance.now() - t0 < maxMs) {
      await frame();
      if (world.worldSize() > 0 && world.pendingTerrainCount() === 0) { if (++quiet >= quietFrames) return true; } else quiet = 0;
    }
    return false;
  };
  const send = (intent) => {
    const full = { type: 'sculpt', tool: 'stamp', profile: 'hard', seq: seq++, ...intent };
    const ok = connection.sendSculpt(full);
    if (ok) world.predictSculpt(full);
    return ok;
  };
  const rayTo = (x, y, z, elDeg, azDeg, dist = 30) => {
    const el = elDeg * Math.PI / 180, az = azDeg * Math.PI / 180;
    const dx = Math.cos(el) * Math.sin(az), dy = Math.sin(el), dz = Math.cos(el) * Math.cos(az);
    return { origin: { x: x + dx * dist, y: y + dy * dist, z: z + dz * dist }, direction: { x: -dx, y: -dy, z: -dz } };
  };
  const size = world.worldSize();
  const flatRegion = (x0, y0, w) => {
    const b = band(x0, y0);
    if (b === null) return null;
    for (let y = y0; y < y0 + w; y++) for (let x = x0; x < x0 + w; x++) {
      if (!world.revealedAt(x, y) || band(x, y) !== b) return null;
    }
    return b;
  };
  const findTargets = (count) => {
    const found = [];
    const REGION = 20, OFFSET = 10;
    for (let cy = 1; cy < size / CHUNK - 1 && found.length < count; cy++) {
      for (let cx = 1; cx < size / CHUNK - 1 && found.length < count; cx++) {
        const tx = cx * CHUNK + opts.localOffset, ty = cy * CHUNK + opts.localOffset;
        if (!world.revealedAt(tx, ty)) continue;
        if (found.some((e) => Math.abs(e.tx - tx) < 40 && Math.abs(e.ty - ty) < 40)) continue;
        const b = flatRegion(tx - OFFSET, ty - OFFSET, REGION);
        if (b !== null && b >= opts.minBand && b <= opts.maxBand) found.push({ tx, ty, base: b });
      }
    }
    return found;
  };
  if (!(await settle(120000))) return { error: 'initial settle timeout' };
  const out = { mode: opts.mode, mesher: world.terrainMesherActive(), size };
  const [pitSite, strokeSite] = findTargets(2);
  if (!pitSite || !strokeSite) {
    const hist = {};
    let revealed = 0;
    for (let y = 0; y < size; y += 4) for (let x = 0; x < size; x += 4) {
      if (!world.revealedAt(x, y)) continue;
      revealed++;
      const b = band(x, y);
      hist[b] = (hist[b] ?? 0) + 1;
    }
    return { ...out, error: 'no flat target found', revealed, hist };
  }
  // Dig a flat basin into the plateau so raises have headroom under the height cap.
  const BASIN_RADIUS = 8;
  for (const site of [pitSite, strokeSite]) {
    for (let k = 0; k < opts.basinDepth; k++) {
      send({ x: site.tx, y: site.ty, radius: BASIN_RADIUS, dir: -1 });
      if (k % 4 === 3) { await sleep(300); await settle(); }
    }
    await sleep(600); await settle();
    site.plateau = site.base;
    site.base = band(site.tx, site.ty);
    site.basinRing = [band(site.tx - 5, site.ty), band(site.tx + 5, site.ty), band(site.tx, site.ty - 5), band(site.tx, site.ty + 5)];
  }
  out.pitSite = pitSite; out.strokeSite = strokeSite;

  // Dig a 2x2 pit, two bands deep.
  const { tx, ty, base } = pitSite;
  const pit = [[tx, ty], [tx + 1, ty], [tx, ty + 1], [tx + 1, ty + 1]];
  for (let k = 0; k < 2; k++) {
    for (const [x, y] of pit) send({ x, y, radius: 1, dir: -1 });
    await sleep(400); await settle();
  }
  await sleep(500); await settle();
  out.denial = world.denialHint();
  out.pitAfterDig = pit.map(([x, y]) => band(x, y));
  out.rimAfterDig = [band(tx - 1, ty), band(tx + 2, ty), band(tx, ty - 1), band(tx, ty + 2)];

  // A: which cell does a pick of the pit floor name?
  const floorY = cap.drawnBandCapY(base - 2);
  const inPit = (x, y) => pit.some(([px, py]) => px === x && py === y);
  const picks = [];
  for (const el of [55, 70, 85]) for (let az = 0; az < 360; az += 45) {
    for (const [px, py] of pit) {
      const r = rayTo(px * CWS, floorY, py * CWS, el, az);
      const p = world.pickCell(r.origin, r.direction);
      const a = p ? foot.footOfFaceCell(p, r.direction, size) : null;
      picks.push({ el, az, cell: [px, py], pick: p && [p.x, p.y], face: p?.face ?? null, band: p?.band ?? null, anchorInPit: a ? inPit(a.x, a.y) : null });
    }
  }
  out.pickTotal = picks.length;
  out.pickNull = picks.filter((p) => p.pick === null).length;
  out.pickInPit = picks.filter((p) => p.pick && inPit(p.pick[0], p.pick[1])).length;
  out.anchorInPit = picks.filter((p) => p.anchorInPit).length;
  out.pickSamples = picks.filter((_, i) => i % 12 === 0);

  // B: three Stamp/Hard/2.0 raise clicks aimed at the pit centre.
  out.stampClicks = [];
  for (let press = 1; press <= 3; press++) {
    const r = rayTo((tx + 0.5) * CWS, floorY, (ty + 0.5) * CWS, opts.aimElevation, 0);
    const p = world.pickCell(r.origin, r.direction);
    const a = p ? foot.footOfFaceCell(p, r.direction, size) : null;
    if (a) send({ x: a.x, y: a.y, radius: 4, dir: 1 });
    await sleep(400); await settle();
    out.stampClicks.push({ press, pick: p && [p.x, p.y], anchor: a && [a.x, a.y], pit: pit.map(([x, y]) => band(x, y)), rim: band(tx - 1, ty), outside: band(tx - 6, ty) });
  }

  // C: held-stroke emulation, 120 ms repeat, per-frame pick sampling.
  {
    const { tx: sx, ty: sy, base: sb } = strokeSite;
    const chunkOf = (x, y) => Math.floor(y / CHUNK) * (size / CHUNK) + Math.floor(x / CHUNK);
    const aim = rayTo(sx * CWS, cap.drawnBandCapY(sb), sy * CWS, opts.aimElevation, 0);
    const frames = [];
    let running = true;
    const sampler = (async () => {
      while (running) {
        await frame();
        const t0 = performance.now();
        const p = world.pickCell(aim.origin, aim.direction);
        const pickMs = performance.now() - t0;
        frames.push({ pending: world.pendingTerrainCount(), pick: p && [p.x, p.y], pickMs });
      }
    })();
    const anchors = [];
    let pinned = null;
    for (let press = 0; press < opts.strokePresses; press++) {
      let p = pinned ? world.pickInColumn(pinned[0], pinned[1], aim.origin, aim.direction) : null;
      let repicked = false;
      if (p === null) { p = world.pickCell(aim.origin, aim.direction); repicked = true; }
      if (p === null) { anchors.push({ press, anchor: null, repicked }); pinned = null; await sleep(120); continue; }
      const a = foot.footOfFaceCell(p, aim.direction, size);
      pinned = [p.x, p.y];
      send({ x: a.x, y: a.y, radius: 4, dir: 1 });
      anchors.push({ press, anchor: [a.x, a.y], repicked, dist: Math.hypot(a.x - sx, a.y - sy) });
      await sleep(120);
    }
    await sleep(600); await settle();
    running = false; await sampler;
    const target = chunkOf(sx, sy);
    const sortedMs = frames.map((f) => f.pickMs).sort((a, b) => a - b);
    const runs = [];
    let run = 0;
    for (const f of frames) { if (f.pending > 0) run++; else if (run > 0) { runs.push(run); run = 0; } }
    if (run > 0) runs.push(run);
    out.busyRuns = runs;
    out.stroke = {
      presses: opts.strokePresses,
      frames: frames.length,
      busyFrames: frames.filter((f) => f.pending > 0).length,
      nullPickFrames: frames.filter((f) => f.pick === null).length,
      offTargetChunkFrames: frames.filter((f) => f.pick && chunkOf(f.pick[0], f.pick[1]) !== target).length,
      anchorsMissing: anchors.filter((a) => a.anchor === null).length,
      anchorsFar: anchors.filter((a) => a.anchor && a.dist > 3).length,
      repicks: anchors.filter((a) => a.repicked).length,
      maxAnchorDist: Math.max(0, ...anchors.filter((a) => a.anchor).map((a) => a.dist)),
      pickMsMedian: sortedMs[Math.floor(sortedMs.length / 2)],
      pickMsP95: sortedMs[Math.floor(sortedMs.length * 0.95)],
      anchors,
    };
  }
  // D: pick cost by aim elevation, idle terrain, 8 azimuths x repeats.
  {
    const REPEATS = 25;
    const { tx: sx, ty: sy, base: sb } = strokeSite;
    out.pickCost = {};
    for (const el of [8, 15, 30, 50, 85]) {
      const times = [];
      for (let az = 0; az < 360; az += 45) {
        const r = rayTo(sx * CWS, cap.drawnBandCapY(sb), sy * CWS, el, az, 60);
        // Batched: performance.now() is coarsened to 0.1 ms without cross-origin isolation.
        const t0 = performance.now();
        for (let k = 0; k < REPEATS; k++) world.pickCell(r.origin, r.direction);
        times.push((performance.now() - t0) / REPEATS);
      }
      times.sort((a, b) => a - b);
      out.pickCost[el] = { median: times[times.length >> 1], p95: times[Math.floor(times.length * 0.95)], max: times[times.length - 1] };
    }
  }
  return out;
}
