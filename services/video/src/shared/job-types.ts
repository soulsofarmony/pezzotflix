// Job types that cross module boundaries: the producer enqueues, another module handles them.
// Modules never import each other, so both sides type-check against these names and payloads.

export const JOB_TYPES = {
  /** Handled by library: scan one root, or every configured root. */
  libraryScan: 'library.scan',
  /** Enqueued by library, handled by analyzer. */
  analyzerProbe: 'analyzer.probe',
  /** Enqueued by analyzer (after a probe) and library (after a rename), handled by identifier. */
  identifierIdentify: 'identifier.identify',
} as const;

export interface LibraryScanPayload {
  rootId?: string;
}

export interface AnalyzerProbePayload {
  fileId: string;
}

export interface IdentifierIdentifyPayload {
  fileId: string;
}
