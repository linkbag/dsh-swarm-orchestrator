/** Versioned, conservative capability declaration. Not a claim about deployment defaults. */
export const HARDENING_CAPABILITIES = Object.freeze({
  version: 1,
  policyVersion: 1,
  storeProtocol: 3,
  observedReviewCas: true,
  structuralArtifactValidation: true,
  meaningfulCursorWaits: true,
  writeScopes: 'advisory' as const,
  readConfinement: false,
  descendantAdmission: false,
  strictIsolation: false,
  requestCoverage: 'observed-llm-stream' as const,
  physicalWireCoverage: 'not-certified' as const,
  hardBudgets: false,
})
