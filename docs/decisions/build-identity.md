# Build identity

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-19 (build-identity watermark, and two knobs closed)

**Version watermark (owner request).** Both halves of the stack stamp a build
identity `<commit count>.<short hash>` derived from git — server at boot
(`server/src/version.ts`, carried on the join snapshot as `serverVersion`),
client at Vite start (`define` in `client/vite.config.ts`). The HUD renders
both top-right (`ui/VersionWatermark.tsx`) and turns loud on mismatch. Why:
2026-08-19, a Vite-only restart after a shared/ commit served a client on
newer terrain math than the server — every stroke previewed one thing and
applied another. Derived-from-git means versions bump on every commit by
construction; `TERRACE_VERSION` overrides where .git is absent (docker, #8).
Operational rule that goes with it: **a stack restart restarts both halves
together, always.**

**Knobs closed with the owner (2026-08-19):** co-located sea-monster spawns
stay as they are — overlapping god-beasts shielding each other is emergent
flavor, not a bug (no spawn offset); the three #25 test towers and consumed
relics on Frostwick Hollows stay as landmarks. (The kraken reachability knob
was closed the same day — see the Deep Strata section above.)
