// Per-session tracker of files whose earlier `read` or `write` output was
// folded out of the active context window and has not yet been re-read.

const MAX_TRACKED_SESSIONS = 512
const foldedUnreadBySession = new Map<string, ReadonlySet<string>>()

export function setFoldedUnreadPaths(sessionId: string | undefined, paths: readonly string[]): void {
  if (sessionId === undefined || sessionId === '') return
  if (paths.length === 0) {
    foldedUnreadBySession.delete(sessionId)
    return
  }
  if (foldedUnreadBySession.has(sessionId)) foldedUnreadBySession.delete(sessionId)
  foldedUnreadBySession.set(sessionId, new Set(paths))
  while (foldedUnreadBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = foldedUnreadBySession.keys().next().value
    if (oldest === undefined) break
    foldedUnreadBySession.delete(oldest)
  }
}

export function isFoldedUnreadPath(sessionId: string | undefined, candidates: readonly (string | undefined)[]): boolean {
  if (sessionId === undefined || sessionId === '') return false
  const blocked = foldedUnreadBySession.get(sessionId)
  if (blocked === undefined || blocked.size === 0) return false
  return candidates.some(candidate => candidate !== undefined && candidate !== '' && blocked.has(candidate))
}

export function foldedUnreadErrorMessage(displayPath: string, toolName = 'edit'): string {
  return `The earlier read output for ${displayPath} was folded out of the active context window. `
    + `Call \`read\` on ${displayPath} again to inspect its current content before calling \`${toolName}\`.`
}
