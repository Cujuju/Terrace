# Skiffs + draw-calls arc — common brief (read first, every phase)

## Where you work
**Worktree:** `/mnt/e/Development/Projects/Terrace-wt-skiffs`, branch
`arc/skiffs-and-draw-calls`. `node_modules` is already installed there.
ALL work happens in that path. Never edit
`/mnt/e/Development/Projects/Terrace` (the shared checkout — other agents are
live in it). Use absolute paths everywhere; `git -C <path>`, never `cd &&`.

Do NOT call ExitWorktree and do NOT merge to main. The orchestrator merges.
Commit to `arc/skiffs-and-draw-calls` when your phase is done.

## The plan is binding
`.claude/plans/skiffs-and-boat-draw-calls.md` in the worktree. It has verified
file:line evidence, per-phase done-criteria, and the rejected alternatives.
Read your phase's section in full before touching anything. If you find the
plan's evidence is WRONG at a file:line, say so with the contradicting
file:line — do not silently work around it.

## Owner decisions, already made this session (2026-09-05)
1. **Sharks are fishable.** S1 derives the fishable set from
   `habitat: 'shallow'` with no exclusion list. Sharks are in it. Confirmed.
2. **Skiffs are village-bound**, not roaming. A skiff targets shoals only
   within a fishing range of its home village and always returns home.
3. The owner has authorised starting/restarting the **isolated bench stack**
   (ports 2599/5199) and the bench client. You may NOT touch the owner's own
   server on 2567 or Vite on 5173, and you may NOT touch their `WORLDS_DIR`.

## Hard constraints (project CLAUDE.md + docs/DESIGN.md)
- `shared/` is the one source of terrain math. Never duplicate it. `shared/`
  is erasable-TS only: no enums, no namespaces.
- Terrain math is deterministic: integer-only or exactly-specified IEEE, fixed
  iteration order, identical on server and client.
- Clients send intents, never heights. The server is authoritative.
- Nothing gamey in core — game rules live in plugins.
- Plugins may not import each other. Cross-plugin talk is the event bus
  (`WorldApi.emitEvent`) or the wire.
- **THE arc constraint:** skiffs draw through exactly ONE `InstancedMesh`
  (`plugins/structures/client/skiffModels.ts:363`). Never move a skiff onto the
  war-boat rig path (`plugins/boats/client/models.ts:376` -> `instantiateRig`)
  — that is 3 draw calls per hull and the frame is already over budget.
- **No magic numbers.** Every literal that encodes a design decision gets a
  named constant whose name states the decision.
- TypeScript strict. No `any` without a comment saying why.
- A `.tsx` exports only components. Never `export` a runtime value from a
  `.tsx`; promote to a sibling `.ts` only when >=2 modules use it.
- Comments: prefer none; when needed, hard cap 30 words.

## Tests — permission is narrow
The owner granted **contract-level tests only**, this session. Write tests
that pin the CONTRACT (the rule, the invariant, the parser's accept/reject
set). Do NOT write per-callsite or wiring tests. Do NOT add tests outside the
phase you were given.

## Verification bar — evidence, not claims
- `pnpm typecheck` must pass (run it in the worktree).
- Run the test suites for **the packages you touched only**, with a timeout.
  NEVER `pnpm -r test` across the workspace — it hangs.
  e.g. `timeout 300 pnpm --filter <pkg> test`
- A comment in the source is a CLAIM, not evidence. Anything you assert about
  existing behaviour must be backed by a file:line you read this session, or
  by a measurement you took this session.
- Label every assumption where you rely on it ("Assumption: ...").

## Reporting back
End your report with:
1. Commit SHA(s) on `arc/skiffs-and-draw-calls` and the exact files touched.
2. Evidence for each done-criterion in your phase's plan section — the command
   you ran and its output, not a summary.
3. Anything you did NOT do and why.
4. Any owner decision you hit that was not pre-answered above. Do not guess —
   stop and report it.
