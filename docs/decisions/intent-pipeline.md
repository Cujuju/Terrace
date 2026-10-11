# Intent pipeline

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-18 (issue #19) — the intent pipeline splits verdict from effect

- **A denied intent now costs a player nothing, structurally.** The residual
  named when the yeti/habitat-regime work landed (§3.5's interceptor chain,
  and monsters' `protection.ts`, both said so out loud): mana charged for a
  sculpt inside its own `onIntent`, before later interceptors in the chain
  got a chance to veto it, so a raise Cthulhu blocked still cost mana. Root
  cause, stated once, without naming either plugin: **`onIntent` conflated
  "would you allow this" with "it happened"**, so any plugin that answered
  the second question from inside the first was exposed the moment a LATER
  plugin answered the first question "no". Two plugins already exercise
  `onIntent` for real work (mana denies, monsters denies, relics modifies);
  mana was the one plugin doing so with a committed side effect, which is
  exactly the shape the bug needed.

  **Contract fix: TWO-PHASE intent processing, and it fits the existing
  `TerracePlugin` shape without breaking it.** `onIntent` keeps its exact
  signature and exact chain semantics (allow / deny / modify, first deny
  wins, a throw treated as allow) and becomes VERDICT-ONLY by contract — see
  its doc comment in `server/src/plugins/types.ts`, which states the rule a
  plugin author reads before writing one. A new, additive hook,
  `onIntentApplied(intent, ctx, diff)`, is the EFFECT phase: core
  (`PluginHost.notifyIntentApplied`, called from `intent/pipeline.ts` step 6)
  fires it exactly once per player intent, and ONLY on the path where every
  interceptor allowed AND the edit actually landed — never on a deny, never
  on a failed re-validation of a plugin's rewrite. This was flagged as the
  preferred shape by both plugins that hit the bug before this fix existed:
  mana's own `onIntent` doc comment named "the fix belongs in core (an
  `onIntentApplied(intent, ctx, diff)` hook)" as the identified fix, and
  `protection.ts` pointed at "a post-chain hook so a charge can be committed
  or refunded." This is that hook, under the exact name mana's comment
  proposed.

  **Why split the hook instead of a post-chain refund.** A refund hook was
  the task's documented fallback if two-phase could not fit the existing
  contract — it does not apply here: nothing about `TerracePlugin`,
  `IntentVerdict`, or the chain's first-deny-wins semantics needed to change
  to add a second, additive, optional hook. A refund model would have made
  every side-effecting plugin implement undo logic (mana would need to
  remember what it charged, in case it needs to hand it back) for a mutation
  that need not have happened at all; asking a plugin to answer "what did I
  commit that I might need to undo" is strictly harder than "here is what
  actually happened, act on it once." The chosen shape also composes: a
  THIRD plugin's future side effect (a cooldown, a resource other than mana)
  gets the same one-hook answer, with no new pattern to invent.

  **The verdict must bind to the effective intent (2026-09-01, issue #278).**
  Charging the effective intent (above) exposed a gap on the verdict side: a
  plugin that ALLOWED the original intent was never asked about the rewrite
  a later plugin produced. mana approved radius 2, relics widened it to 3,
  and mana — which sorts first — was billed for 3 with no floor on the pool,
  so a check that had passed produced an overdraft and a lock-out until
  regen repaid it. Fix, in `PluginHost.runIntent`: when any plugin modifies,
  every plugin that allowed is asked once more against the effective intent
  and may deny it. Modifiers are NOT re-asked — their rewrite is the
  effective intent, and re-running an unconditional widener would compound
  it (2→3→4) unless every modifier learned to recognise its own work, a
  convention rather than a guarantee. A `modify` returned on that second
  look is refused as a deny and booked as a plugin fault; there is no third
  pass, so the chain always settles. Rejected: clamping the charge at zero
  (makes the widened area free exactly when the player is broke, against the
  "charge the effective intent" rule); a plugin idempotence contract with a
  full re-run (buys nothing the allower-only re-ask does not, and costs a
  rule every plugin author must remember).

  **What `onIntentApplied` hands a plugin, and why.** `intent` is the
  EFFECTIVE intent — after any earlier plugin's `modify` — not the one this
  plugin's own `onIntent` saw, because the hook describes what HAPPENED, and
  what happened is the effective intent's edit (it matches `diff` exactly).
  `ctx` is the same `{ player, world }` shape `onIntent` already receives, so
  a plugin migrating a charge from one hook to the other changes nothing
  about how it reads the player or reaches `WorldApi`. `diff` is the full,
  unfiltered server-side diff, the same one `onTerrainChanged` receives —
  `onIntentApplied` is intent-scoped (fires only for a player's own sculpt,
  never for a plugin-initiated `WorldApi.sculpt`) where `onTerrainChanged`
  is diff-scoped (fires for every edit, whoever made it); a plugin that needs
  "an edit happened" already has `onTerrainChanged`, and this hook exists for
  "MY intent's own effects, now that it is certain to have applied."

  **Enforcement is by contract and by call-site placement, not by
  sandboxing `WorldApi`.** `onIntent` still receives the same full `WorldApi`
  it always has; core does not intercept or block `sculpt`/`unlockChunk`/
  `broadcast`/`sendTo` during the verdict phase. The considered, rejected
  alternative was a read-only `WorldApi` view for the verdict phase, which
  would make "cannot mutate" a runtime guarantee rather than a documented
  one. Rejected for this pass: every shipped plugin's `onIntent` is already
  read-only in practice (see the audit below), so the guard would protect
  against a violation nothing in this repo currently commits, at the cost of
  a second `WorldApi` shape to build, test, and keep in sync with the real
  one, and — because `sendTo` is deliberately still allowed for a plugin's
  own final deny (see below) — the guard could not even be a blanket
  denylist without becoming a special case anyway. What IS structural: the
  ORDER core calls things in. `intent/pipeline.ts` reaches
  `notifyIntentApplied` from exactly one place, on the one code path that
  runs after every earlier `return` (malformed, locked, plugin-denied,
  plugin-modified-invalid) was skipped — so "effects run only after
  unanimous allow" is a call-graph fact, not a policy plugin authors are
  merely asked to respect, and it is what `server/test/intent-pipeline.test.ts`
  and `server/test/plugin-host.test.ts` pin down. A sandboxed `WorldApi` for
  the verdict phase remains available as a stronger, later hardening step if
  a third-party plugin's `onIntent` is ever found mutating state; nothing
  about this design forecloses it.

  **The one allowed exception, and why it does not weaken the contract.** A
  plugin denying ITS OWN way (`world.sendTo` from inside its own `onIntent`,
  to explain that denial — mana's `mana:denied` push is the shipped example)
  is safe under two-phase for a reason specific to first-deny-wins: that
  denial can never be overturned by a later interceptor, so there is nothing
  for the message to become stale against. This is different in kind from a
  committed STATE mutation (mana's old in-place balance deduction), which
  needed undoing exactly because a later plugin's decision could invalidate
  it. The rule stated in `onIntent`'s doc comment is precise about this: no
  mutation that would need to be undone on a later veto, not no network
  traffic at all.

  **Per-plugin side-effect audit (every shipped `onIntent` implementation).**
  Three plugins implement it; `reveal` and `weather` do not.
  - **mana** — the one with a real side effect (a balance deduction). Split:
    `checkAffordability` (verdict; reads the pool, may send `mana:denied` on
    its own deny, never mutates) and `commitCharge` (effect; the deduction
    and the `mana:balance` push, now living in `onIntentApplied`).
  - **monsters** — `guardGround`/`reachesProtectedGround` only ever READS
    monster state to answer allow/deny; no `onIntentApplied` needed or added.
  - **relics** — Titan's Hand's `onIntent` only ever READS which skills a
    session holds to answer allow/modify; no `onIntentApplied` needed or
    added. See the NAMED CONSEQUENCE below.

  **Named consequence: Titan's Hand's brush widening is no longer free
  extra area.** Before this fix, mana charged during the verdict phase
  against the intent AS MANA SAW IT — before relics (which sorts after mana
  alphabetically) ever widened the brush — so the extra radius Titan's Hand
  grants cost nothing extra. `onIntentApplied` charges against the EFFECTIVE
  intent, which already includes that widening, so the skill is now priced
  like any other radius increase. This was foreseen, not incidental: relics'
  own `onIntent` doc comment already named "the post-apply hook core does not
  yet have" as the one thing that would change this, calling it "the same
  gap mana documents" — this is that hook, and closing it is accepted as the
  correct read of "proportional to the terrain volume its brush nominally
  displaces" (§3.5's mana pricing decision), not a scope-creep side effect.
  No test in this repo pinned the old "free extra area" number, so nothing
  broke; `plugins/relics/server/index.ts`'s doc comment states the new
  behaviour where the old one used to.
