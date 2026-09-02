# Camera

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-19 (touch-dolly guard — the two-finger camera reset)

**Touch-dolly guard.** OrbitControls' two-finger dolly divides each move's
finger separation by the last one it saw, unguarded; iOS touch coalescing can
collapse the reported separation to ~zero for one frame, which slams the
orbit distance to a zoom clamp (owner: "two-finger tap resets the camera to a
default location"; reproduced via CDP, 200px→1px → distance 80→900 — and at
distance 900 the distance-scaled pan explains the earlier "jumps across the
map"). Two independent layers sit in front of OrbitControls, which stays
unpatched: a pair born under `TOUCH_DOLLY_MIN_SEPARATION_PX` (24 px) is
treated as one coalesced contact and gets `touches.TWO: null` for its
gesture, and any move stepping separation beyond `TOUCH_DOLLY_MAX_STEP_RATIO`
(1.5×) in one event is swallowed at document capture. The guard's baseline
advances only on moves OrbitControls actually saw, so a swallowed artifact
costs nothing and honest pinches are untouched (verified live: 80→56.5
across a 120→170 px spread, exactly the theoretical ratio). Contract pinned
in `client/test/touchGuard.test.ts`.
