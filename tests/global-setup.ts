// Cleanup belongs to each fixture's exact owned directory, not a prefix snapshot.
// A concurrently running suite (or the live host) may create matching names.
export function setup(): void {}
export function teardown(): void {}
