---
description: Run npm test and report the TDD verdict in plain English
allowed-tools: Bash(npm test:*), Bash(git status:*), Bash(git diff:*), Bash(git log:*), Read
---

Run the suite through the only supported entry point (PRD §16.2). Never use `npx vitest` or call vitest directly.

```bash
npm test -- --run 2>&1
```

(`--run` is passed through to vitest so it exits instead of entering watch mode. The script runs `tsc --noEmit` first; a type error short-circuits before vitest starts.)

## Reporting

**All passed, zero skipped:** reply with exactly `All green — N tests passed.` and nothing else.

**All passed but some skipped:** per §16.2, green never means skipped. Reply `N passed, M skipped — <skip reason from the warning, e.g. missing env var>.` and nothing else.

**Anything failed (assertion, collection error, or `tsc` error):** classify it, using `git status`, `git diff`, `git diff --staged`, and `git log -5 --stat` to see what changed recently. Reply in **one sentence** with exactly one of:

- **Expected TDD red** — the test asserts on a symbol, export, field, or shape that isn't built yet in `src/` (missing export, missing module, missing property). You're on track.
- **Regression** — a test that previously passed now fails because of a recent change to source code. Name the failing test and the likely-culprit change (file + what changed).
- **Test bug** — the test file itself was just edited and now asserts something wrong (contradicts the PRD or the existing correct implementation). Name the test and the bad assertion.

If more than one category applies, lead with the most serious (regression > test bug > expected red) and name the others in the same sentence.

Then stop. Do not propose a fix, do not edit files, do not re-run the tests, do not summarize the output beyond that sentence.
