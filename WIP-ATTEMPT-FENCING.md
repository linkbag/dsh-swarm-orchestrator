# J19 attempt fencing — precise diagnosis

## Status: NOT WORKING. Do not merge. 89/90 on this branch.

`tests/service.test.ts > watchdog escalates after 3 nudges` fails. Baseline passes it
in 62 ms, so this branch is the cause.

## What the probes proved

Instrumenting the settle path produced exactly TWO lines per run:

    [J19] SETTLE      task=a mine=att-...-kfrnhnpx live=att-...-3u7cegni ok=true stop=completed
    [J19] SUPERSEDED  task=a mine=att-...-kfrnhnpx live=att-...-3u7cegni status=running attempts=2 ok=true

Read that carefully:

1. **Only ONE settle fires — attempt 1's.** Attempt 2's `.then()` callback never reaches
   the settle block. `[J19] SETTLE` and `[J19] NONRUNNING` never appear a second time.
2. **Attempt 1 resolved as `ok=true stop=completed`**, even though the watchdog aborted
   it. So the abort did not settle attempt 1's held promise; `fake.release()` did.
3. **Attempt 2 is the live attempt** (`live=att-...3u7cegni`) and the task is `running`
   with `attempts=2`. The retry genuinely launched.

Conclusion: the fence comparison itself is behaving correctly here (attempt 1 is rightly
superseded), but **attempt 2's result never reaches the settle path**. The fault is
upstream of the fence — in `spawnTaskAgent`'s result path or the `ensureAnchor` chain —
not in the fence logic.

## Ruled out

- `abortAware` is only set in the two J8 tests (~lines 1401/1425), not in the watchdog
  test, so an abort-driven settle cannot be what resolved attempt 1.
- A missing `await`: `adoptTaskReport` is synchronous on this branch.
- Fence clearing: an earlier revision of this branch DID clear `liveAttempts` in the
  superseded branch, which made the live attempt's own settle look superseded. Fixed —
  the probes above are from AFTER that fix.

## Next step (do this first)

Probe immediately after `const outcome = await spawnTaskAgent(...)` in `startSpawn`,
logging the attemptId and outcome, plus a probe at the TOP of the
`ensureAnchor(...).then(...)` callback logging that it was entered. That separates:

  (a) the `.then()` never running for attempt 2 (the anchor promise rejected and
      `.catch()` swallowed it — look for a "crashed dispatcher bookkeeping" warning);
  (b) the `.then()` running but `spawnTaskAgent` never resolving (its internal
      `run.result` never settles for the second child); or
  (c) the `.then()` running and resolving, with an early `return` before the probes.

Most likely (b): the fake's `release()` drains `this.held` with `splice(0)`, so if
attempt 2's child was pushed to `held` AFTER release ran, its promise stays pending
forever. That is a TEST-harness ordering issue rather than a product defect — which is
precisely why the fence must not be allowed to depend on it.

## Value delivered so far

The fence found and fixed a REAL defect on the way in: `recoverOrphans` guarded only on
`inFlight`, which does not exist during a launch's async window, so boot recovery could
fail a task that had just started — the same `host restarted mid-flight` failure seen in
the live smoke run. Recovery now also skips any task holding a fence, which is the
authoritative ownership signal because it is set synchronously at launch.

## How to verify when it is fixed

1. `npx vitest run tests/service.test.ts -t "watchdog escalates"` must pass.
2. `npx vitest run` — all 90 on this branch.
3. Merge `main` in, then `npx vitest run` again: the fault-matrix identity assertions
   (FM1/FM4/FM9) tighten automatically from counting to full attempt-identity checks.
   Those three currently pass on main *because* fencing is absent; after the merge they
   become real verification of it.
