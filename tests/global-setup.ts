// Temp-directory hygiene: the suite creates `swarm-service-*` / `swarm-settings-*`
// directories under the OS temp dir (temp homes and storage roots), and before this
// ran there were 2,197 of them left on the machine. Snapshot the set before the run
// and remove only what the run itself added - a dev machine may hold directories the
// running host still owns, so nothing pre-existing is ever touched.
import { readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIXES = ['swarm-service-', 'swarm-settings-'] as const

function listTempDirs(): string[] {
  try {
    return readdirSync(tmpdir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PREFIXES.some((prefix) => entry.name.startsWith(prefix)))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

const preexisting = new Set(listTempDirs())

export function setup(): void {
  // Intentionally empty: the snapshot above is the whole mechanism.
}

export function teardown(): void {
  let removed = 0
  const failed: string[] = []
  for (const name of listTempDirs()) {
    if (preexisting.has(name)) continue
    try {
      rmSync(join(tmpdir(), name), { recursive: true, force: true })
      removed += 1
    } catch {
      // Read-only or ACL stragglers must not fail a green suite; they are reported.
      failed.push(name)
    }
  }
  console.log(`[temp-hygiene] removed ${removed} temp dir(s) created by this run`)
  if (failed.length > 0) console.log(`[temp-hygiene] could not remove ${failed.length}: ${failed.slice(0, 5).join(', ')}`)
}
