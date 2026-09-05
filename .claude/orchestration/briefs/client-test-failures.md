# Brief: two pre-existing client test failures — pickAgreesWithMesh, vertexGrid

Repo: /mnt/e/Development/Projects/Terrace (pnpm workspace, TS strict, Vitest, three.js client).
Work ONLY in your own worktree. Create it first:
  git -C /mnt/e/Development/Projects/Terrace worktree add .claude/worktrees/client-test-fix -b client-test-fix main
Absolute worktree root: /mnt/e/Development/Projects/Terrace/.claude/worktrees/client-test-fix
Never edit or run git against the main checkout. Commit to branch client-test-fix. Do not push.

Hard rules:
- shared/ is the single source of truth for terrain math; deterministic, integer-only (or exactly-specified IEEE ops with immediate integer floor), fixed iteration order. Never duplicate its math in client/.
- Comments are claims, not evidence: cite file:line of executed code.
- Do NOT write new tests. You may edit an existing failing test ONLY if you can prove its expectation is stale (cite the commit that changed the contract via `git log -S` / `git blame` and the code that now defines the behavior). Otherwise fix the source.
- Fix the root cause, not the symptom. No magic numbers.

Steps:
1. cd <worktree>/client && timeout 240 npx vitest run  (per-package only; never workspace-wide). Check `uptime` first — a load average in the dozens means stale chrome-headless-shell processes are starving workers; report that rather than misdiagnosing.
2. Capture the exact failure output for pickAgreesWithMesh and vertexGrid. Find the test files (grep -rn in client/test).
3. For each: state in one sentence the root cause without naming a callsite. Determine whether source or test drifted, with git evidence (`git log --oneline -- <file>`, `git log -S'<symbol>'`).
4. Apply the fix. If the same shape of drift exists elsewhere, say so.
5. Re-run the client package tests; cd <worktree> && pnpm typecheck. Both outputs verbatim in the report (trimmed to the summary lines).
6. Commit with a conventional message (fix:/test:), no attribution lines, no footers. Do NOT merge.

Final report (short): per failure — root-cause sentence, what changed (file:line), git evidence; commit hash; vitest + typecheck summary; anything you judged out of scope, with a yes/no decision and one-line reason.
