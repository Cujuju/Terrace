# Chronicle

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-19 (world events & the Chronicle — mechanics card 46)

**World events & the Chronicle.** Core gains one neutral primitive:
`WorldApi.emitEvent(type, payload)` fans out to every plugin's `onWorldEvent`
in load order, server-side only, event name namespaced with the emitter's name
exactly like wire messages (unforgeable, collision-free), depth-guarded at 4
like terrain cascades. Consumers subscribe by emitter NAME and validate
payloads structurally — never by import; cross-plugin agreement travels as
documented copies pinned by shared golden vectors (chronicle ↔ structures race
derivation). Emitters: structures `changes` (cause generation/sculpt), relics
`collected`, monsters `arrived`/`departed` (queued at summon/banish, the
lifecycle's single entrance/exit; snapshot restores never announce). The
chronicle plugin is the first pure consumer: deterministic saga lines (no RNG;
integer-millisecond clock, 600 s = one "day"; hashed place names), coordinates
never on the wire so plain `broadcast` is fog-safe by construction; slice
persisted in the world snapshot, capped at 512 entries oldest-out. What earns a
line: placed seeds, world-first tiers above camp, ≥3 homes lost in one chunk in
one event (below = CA churn), collections, monster firsts/returns/departures.

## Decisions made 2026-08-19 (the banner is the chronicle's door)

**World-header action registry (owner move).** Core gains a world-header
action registry (`plugins/hudPanels.ts`): ONE plugin may claim the top-centre
world banner — core renders the claimant's icon right of the world name and
the whole banner becomes a button (aria-label from the action; the
name/rating tooltips survive as inner titles). First registration wins, the
`onCanvasPress` precedence rule; later claims warn and are ignored;
unclaimed = the inert title card. The chronicle claims it and its info-panel
row is gone; its reader mounts from a bare `top-center` host ('panel'
placement would unmount with a collapsed phone panel). Phone widths: the
banner's max-width is derived as `100vw − 2·120px` so a centred banner clears
the ~110px Info tab and watermark; long names ellipsize.
