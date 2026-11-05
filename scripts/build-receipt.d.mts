export interface BuildReceipt {
  version: 1
  scope: 'full' | 'client-only'
  toolchain: { node: string; typescript: string; esbuild: string }
  inputs: Record<string, string>
  outputs: Record<string, string>
}
export function collectBuildInputs(root: string): Record<string, string>
export function collectBuildOutputs(root: string): Record<string, string>
export function makeBuildReceipt(root: string, scope: BuildReceipt['scope']): BuildReceipt
export function validateBuildReceipt(root: string, receipt: unknown): string[]
