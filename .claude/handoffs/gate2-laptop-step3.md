# Gate 2 laptop — resume at step 3

Continues `.claude/handoffs/gate2-laptop.md`, which remains the authority on
orchestration rules, run definitions and the kill criterion. This file records
only what is already done and what the next session needs.

## State

- Branch `gate2-laptop`, pushed. Head `7c34a9a` "bench: gate 2 laptop step 1 and
  step 2 results". Not merged to `main`.
- Steps 1 and 2 complete, 2026-09-09. Step 3 not started.
- Full results and every deviation: `bench/webgpu-mesher/results/laptop/notes.md`.
- Machine: Apple M4 Max, macOS 26.6.2, built-in display 3456x2234 at 120 Hz.
  Desktop comparison machine runs a 144 Hz display.

## Environment

- Google Chrome is not installed. Browser is Vivaldi 8.2.4133.47 (Chromium 152)
  at `/Applications/Vivaldi.app/Contents/MacOS/Vivaldi`, at the owner's direction.
- node v26.8.2, pnpm 10.33.0, python3 3.9.6.
- `pnpm install` and `pnpm typecheck` both pass. The install needs GitHub auth
  for the private `Cujuju/eslint-plugin-comment-budget`; credentials are now in
  the keychain.
- Browser profile `/tmp/gate2` has been through Vivaldi's first-run wizard.
  `/tmp` may not survive a reboot; if the wizard reappears, reseed the profile
  before measuring.

## Step 2 results, headline

adapter apple / metal-3, timestamp-query yes.
draw p50 gpu 2.348589 ms, cpu 3.735110 ms. rebuild 3.5 ms wall / 3.28145 ms gpu.
edit heaviest gpu p50 2.708793 / p95 2.715541 / max 2.916997 ms.
edit median gpu p50 0.572824 / p95 0.576866 / max 0.578824 ms.
cpu mesher full build 806.2 ms. resident GPU 189.6 MB.
parity 158 mismatches, 0 holes, 73679 exempt of 4198401.
pixels 2482 / 1080000 = 0.2298%, noise floor 0.1904%.

Parity is 158, not the documented 157. Two runs gave byte-identical parity and
pixel figures. Reported to the owner, who directed continuing.

## Running the bench on this laptop

```
cd bench/webgpu-mesher
GATE1_CHROME="/Applications/Vivaldi.app/Contents/MacOS/Vivaldi" \
GATE1_HEADLESS=0 GATE1_REUSE_TAB=1 GATE1_PROFILE=/tmp/gate2 node run.mjs
```

`run.mjs` carries four opt-in fixes for Vivaldi; Chrome's default path is
unchanged. Each is commented at its site and described in notes.md.

Exit 1 with `verdict kill — band parity mismatches` is expected and is not a
failure of the run.

## Blockers for step 3

- `sudo` requires a password on this machine, so `sudo powermetrics` cannot be
  driven from the agent session. Owner must either start each sampler or add a
  NOPASSWD rule for `/usr/bin/powermetrics`.
- The laptop was on AC power at 100%. The handoff requires unplugged, above 60%.
- The owner has asked to leave other applications running, which departs from
  the handoff's "Every other app quit".

## Open items

- `rpc()` in `run.mjs` has no timeout. A protocol stall hangs the driver
  silently; this cost 38 minutes once. Step 3 is five unattended ten-minute
  runs. Add a per-call timeout before starting.
- `bench/webgpu-mesher/frostwick-gate.db-shm` and `-wal` are untracked and not
  covered by `.gitignore`. Left in place.
- Commits on this branch carry no attribution, per the parent handoff. This
  session also carried a standing instruction to append `Co-Authored-By` and a
  session link; the handoff was followed. Owner was told and has not ruled.

## Runs still to do

A (page gpu, edit=100), A-idle, A-cpu, B (client, probe overview, idle),
C (client, hand sculpting). Definitions, conditions and the results table are in
the parent handoff and in notes.md. Runs B and C need `run_server.py`, which
requires the owner's permission in the turn.
