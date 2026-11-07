// Server address helpers shared by the settings page and its tests.

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
  } catch {
    return false
  }
}

/**
 * Turns what the user typed as the server address into a URL: a bare
 * host or host:port (e.g. 100.64.0.8:8060) gets http://.
 */
export function normalizeBaseURL(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '' || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
  return `http://${trimmed}`
}
