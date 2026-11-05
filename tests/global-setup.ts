import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

// Default test runs must never resolve the operator's settings or swarm history.
// Individual fixtures can replace DSH_HOME and restore this isolated baseline.
export function setup(): () => void {
  const previous = process.env.DSH_HOME
  const root = realpathSync(tmpdir())
  const home = realpathSync(mkdtempSync(join(root, 'swarm-test-home-')))
  process.env.DSH_HOME = home
  return () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    if (!home.startsWith(root + sep) || realpathSync(home) !== home) throw new Error('unexpected test home cleanup path')
    rmSync(home, { recursive: true, force: true })
  }
}
