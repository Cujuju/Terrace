# Shader programs: warm the catalogue, and close the double-patch trap

> **Line numbers were correct at commit `909f551` (2026-09-05).** This is a
> shared checkout with concurrent agents — `635ce13 feat(climb)` moved every
> `rigHerd.ts` reference in this document once already. Locate code by the
> SYMBOL, not the line: `grep -n '<symbol>' <file>`. If a cited line does not
> say what this document claims, trust the file and tell the owner.


Two related items from the 2026-09-05 frame-rate investigation
(`docs/plans/frame-rate-decay-2026-09-05.md` §6). Smaller and lower-risk than
the pose-palette work; independent of it.

---

## A. Programs compile mid-play, and each compile stalls

### What was measured

`renderer.info.programs.length` across three four-minute `drift` runs, camera
locked:

| run | start | end |
| --- | --- | --- |
| 1 | 74 | 124 |
| 2 | 88 | 127 |
| 3 | 101 | 123 |

Different starting points, **all converging near ~125**. That is a bounded
catalogue filling in as content types first appear — not an unbounded leak. The
frozen control (inbound server state dropped) held at **72 → 72**, confirming
nothing leaks client-side.

It still costs: each new program is a shader compile, which stalls the frame.
The tail on the same runs was `msP99` 25.7 ms and `msMax` 50.8 ms against a
6.94 ms budget for 144 fps.

### What the variants actually are

three's default `Material.customProgramCacheKey()` returns
`onBeforeCompile.toString()`, so keys in this codebase are 1100+ characters and
end in our own appended suffixes. The distinct new variants observed:

```
…|revealClip
…|cumulusDeck:snow:deck|revealClip
…|cumulusDeck:rain:deck|revealClip
…|cumulusDeck:thunderstorm:deck|revealClip
…|rigHerd:posePalette
…monster-fur-triplanar
…monster-fur-shell-1-of-3   (and -2-of-3, -3-of-3)
```

All legitimately distinct. The problem is *when* they compile, not that they
exist.

### The change

Compile the known catalogue off the critical path instead of during play.
three's `WebGLRenderer.compileAsync(scene, camera, object?)` returns a promise
and compiles without blocking. Candidates for when:

- after the join snapshot, while the camera is still settling and the world is
  streaming in — there is already a long quiet window there;
- or per plugin at mount, for the materials that plugin owns.

**Design question for the owner, not for the implementer to settle alone:**
a plugin's variants cannot be compiled before the plugin has built the
materials, and some are built lazily on first sighting of a content type. So
either plugins gain a "declare your materials for warm-up" hook on
`ClientPluginCtx`, or warm-up is best-effort over whatever exists at the time.
The first is a contract change and belongs to the plugin-host design record;
the second is cheap and partial. Ask before choosing.

### How to prove it worked

```bash
bash scripts/gpu-bench.sh drift before-<label>
# ... change ...
bash scripts/gpu-bench.sh drift after-<label>
```

Success: `newPrograms.total` in the report drops toward zero (the compiles moved
to load time), and `blocks[].frameMsP99` / `msMax` fall. The **program count
itself should still reach ~125** — the catalogue is not the problem, its timing
is. A fix that reduced the final count would mean variants went missing, which
is a rendering bug, not a win.

---

## B. Latent: `applyRevealClip` / `applyGroundShade` are not idempotent

**Not observed in the data. This is a trap, not a diagnosed bug.** Fix it
because it is cheap and because the failure is silent.

Both functions *wrap* the material's existing `customProgramCacheKey`:

- `client/src/render/groundShade.ts:390`
  `material.customProgramCacheKey = () => \`${previousKey()}|groundShade\``
- `client/src/render/revealMask.ts:289`
  `material.customProgramCacheKey = () => \`${previousKey()}|revealClip\``

Apply either **twice to the same material** and the key becomes
`…|revealClip|revealClip` — a different key, so three compiles and caches a
**second, identical program**. Repeated application would grow the program table
without bound, and nothing would report an error.

- `applyGroundShade` is called exactly twice, on two distinct materials
  (`client/src/render/terrainMeshes.ts:794`, `client/src/render/water.ts:487`).
  Safe today.
- `applyRevealClip` is a **public plugin API**
  (`client/src/plugins/types.ts:586`, routed via `client/src/world.ts:1168` and
  `client/src/plugins/host.ts:739`) with ~15 call sites across
  cyclone, fog, rain, snow and thunderstorm.

### The change

1. Audit those call sites for anything that can run more than once against a
   shared material — particularly per-storm / per-strike rig construction in
   `plugins/thunderstorm/client/rig.ts` (lines 301, 302, 448, 518) and
   `plugins/cyclone/client/rain.ts:181`.
2. Make both functions idempotent at the contract layer, not at the call sites:
   a module-level `WeakSet<Material>` of already-patched materials, returning
   early on a repeat. This is the fix that matters — auditing call sites only
   fixes today's callers, and the API is public, so the next caller can make the
   same mistake. (Pre-check item 3: if the only way to describe the bug is "the
   caller forgot", the bug is in the API that lets them forget.)
3. Keep the `needsUpdate = true` behaviour for the first application only.

### How to prove it worked

A `drift` run's `newPrograms.keys` must contain no key with a repeated suffix
(`|revealClip|revealClip`, `|groundShade|groundShade`). Since the defect was
never observed, the honest test is a direct one: call `applyRevealClip` twice on
one material in a scratch harness and assert the cache key is unchanged the
second time.

Tests: the project forbids adding tests without the owner's explicit permission
in the current session — ask before writing any.

Vite on `/mnt/e` never watches — restart Vite after every client edit.
