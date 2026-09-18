# Camera pointer lock: plan

Status: planned, not approved. Written 2026-09-18. Owner direction: on a large
pan the cursor leaves the browser window and the user must drag it back —
lock the pointer for the gesture instead.

## 1. Goal

During a mouse pan/rotate gesture the OS cursor stays exactly where the press
began (hidden in place by the lock); the camera drives from movement deltas;
the brush stays frozen (existing gesture lock); on release the lock exits and
the brush snaps back under the unmoved cursor. Sculpt strokes, touch, and
wheel behavior do not change.

## 2. API facts (verified against the repo, three r185)

- `canvas.requestPointerLock()` must come from a user gesture: our
  `pointerdown` capture handler qualifies. Modern Chrome returns a Promise;
  older/Firefox return undefined — handle both, treat rejection as fallback.
- Chrome throttles re-lock (~1.25s after an Esc exit) and fires
  `pointerlockerror` on refusal. Esc exits the lock with no pointerup.
- Under lock, `mousemove` keeps frozen `clientX/Y` and carries
  `movementX/Y`. `OrbitControls` would contribute exactly zero from those
  coordinates, so it can stay enabled and its `start`/`end` events keep
  driving the existing brush-freeze lock untouched.
- No math to reimplement: this three version exposes public
  `controls.rotateLeft(rad)`, `controls.rotateUp(rad)`, `controls.pan(dx, dy)`
  — the same code path pointer drags use, including `rotateSpeed`/`panSpeed`
  and `clientHeight` scaling. Read the speeds off `controls` live.
- Press classification already exists: `cameraVerb(button, mods)` non-null
  means OrbitControls will act; `resolveSculptPress` non-null means sculpt
  will. Lock only when the first holds and the second does not — left/no-mod
  stays a sculpt stroke by construction. Touch never locks (no cursor).
- `scene.ts` sets no custom rotate/pan speeds, so defaults (1.0) apply;
  mirror formulas must read `controls.rotateSpeed`/`panSpeed`, not constants.

## 3. Design

New module `client/src/input/cameraPointerLock.ts`:

- `engage(canvas, controls, verb, pointerId)`: called from the existing
  `pointerdown` capture in `cameraBindings.ts` when the press is a mouse
  camera verb and `controls.enabled`. Tries
  `requestPointerLock({ unadjustedMovement: true })`, falls back to a plain
  call, falls back to unlocked on any failure. Records the driving pointer.
- Drive on `mousemove` (window, capture): if
  `document.pointerLockElement === canvas` and the pointer is the driver,
  apply `movementX/Y` — orbit: `rotateLeft(2π·mx·rotateSpeed/h)` +
  `rotateUp(2π·my·rotateSpeed/h)`; pan: `pan(mx·panSpeed, my·panSpeed)`.
  Skip when `!controls.enabled`.
- `release()`: `document.exitPointerLock()` iff we hold it; called on window
  `pointerup`/`pointercancel` for the driving pointer and on window `blur`.
- Esc mid-gesture needs no special code: lock loss stops the deltas, the
  still-held pointer keeps driving OrbitControls from real coordinates, and
  `start`/`end` still bracket the brush freeze. Fallback everywhere is
  today's behavior, so every failure mode degrades to the status quo.

`cameraGestureLock.active()` gains `|| pointerLockedForCamera()`: belt and
suspenders for a lock whose `start` event was missed.

## 4. Files

- New `client/src/input/cameraPointerLock.ts` (~80 lines, thin glue only).
- `cameraBindings.ts`: call engage on camera-verb pointerdown; release on
  up/cancel/blur. `cameraGestureLock.ts`: include lock state in `active()`.
- `main.tsx`: no change expected (gate already keys off `active()`).
- No `shared/`, server, terrain, or brush math touched.

## 5. Verification (headed Chrome over CDP, `.brush-verify/`)

- Lock engages on middle/right-drag (`document.pointerLockElement`), exits
  on release; refusal paths fall back silently (force by requesting twice).
- Drive check in-page: call the verb appliers with synthetic deltas via
  `evaluate`, assert the camera moves per the mirror formulas; CDP
  `movementX` under lock is unreliable, so do not assert through it.
- Behavior: existing probe7 pattern — ring frozen across camera travel,
  resumes after; plus cursor-position check (frozen clientX/Y during).
- `pnpm typecheck` + brush tests. No new vitest files without owner
  permission (only candidate: the pure verb-classification helper).

## 6. Non-goals and risks

- Touch gestures, wheel zoom, sculpt strokes: untouched. Firefox: plain-call
  fallback only; Chrome is the target per owner direction.
- Cursor is invisible mid-gesture (platform behavior, standard for
  drag-pan). If the owner wants a visible anchored cursor instead, that is a
  different feature (custom cursor rendering), not this plan.
- Risk: Chrome's post-Esc re-lock throttle makes an immediate second pan
  fall back to cursor travel once — accepted, matches platform norms.
