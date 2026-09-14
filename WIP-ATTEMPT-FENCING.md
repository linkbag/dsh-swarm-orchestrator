wip(J19): attempt fencing — implemented, one test still red

NOT FOR MAIN until tests/service.test.ts "watchdog escalates after 3 nudges"
passes. 89/90 pass; only that test fails.

What is done and believed correct:

- Task gains `attemptId` (types.ts). Each launch mints `att-<ts>-<rand>` and
  publishes it on `task/started`, so the fold knows which attempt owns the task.
- projection.ts discards writes whose attemptId is not the task's current attempt
  (task/completed, task/failed, task/reviewed, task/heartbeat). Events with no
  attemptId (legacy, operator-driven) remain permitted so old logs still fold and
  manual retries are never blocked.
- service.ts records the fence in `liveAttempts` synchronously at launch — BEFORE
  the child is spawned — and every terminal write inside the settle handler carries
  its attemptId. A superseded attempt's result is logged and discarded.

The fence immediately proved its worth: it caught a REAL race between boot orphan
recovery and asynchronous dispatch. `recoverOrphans` guarded only on `inFlight`,
which does not exist during the async window of a launch, so recovery could fail a
task that had just started — the same "host restarted mid-flight" failure the live
smoke hit earlier. Recovery now also skips any task holding a fence, which is the
authoritative ownership signal because it is set synchronously.

Remaining failure, precisely characterised:

In the watchdog test the fake uses holdAll, so a child's `deps.start()` promise
stays pending until fake.release(). The watchdog escalates (attempt 1 -> retrying),
attempt 2 launches and also holds. On release, attempt 1's settle takes the
superseded branch; attempt 2's settle then does not commit and the task is left
`running` with only task/started + task/agent-started recorded. The fence entry for
attempt 2 is intact, so the mismatch is inside the settle path rather than the
watchdog. In production an aborted child settles promptly (the abort actually
resolves the provider call), so this window is largely a harness artefact — but the
fence must not depend on that, so it needs a real fix rather than a test tweak.

Next step to try: instrument the attempt-2 settle to log `liveAttempts.get(key)`
versus its own `attemptId` at entry, and check whether `clearSpawnTimeout()` or the
`fresh.status !== running` branch is being taken first.
