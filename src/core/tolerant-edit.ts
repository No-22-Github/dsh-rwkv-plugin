// Re-export shim: pure `tolerant` engine now lives in `src/core/edit-modes/tolerant.ts`.
export {
  findRegion,
  fitReplacement,
  reindent,
  resolveTolerantEdit,
  similarity,
  toLF,
  TOLERANT_EDIT_MODE,
  type MatchLevel,
  type RegionMatch,
  type RegionResult,
  type ResolvedTolerantEdit,
} from './edit-modes/tolerant.ts'
