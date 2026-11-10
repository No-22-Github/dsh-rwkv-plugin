// Time zones for collected and evaluated trajectories. The desktop app dates
// the system prompt in the user's local zone; training data mirrors its mix:
// mostly Asia/Shanghai, the rest spread over a few common zones. The pick is a
// pure function of a key (the trajectory id), so a rerun of the same
// trajectory gets the same zone. rwkv-agent-pipeline's qc.py recomputes it.

import { createHash } from 'node:crypto'

export const PRIMARY_TIME_ZONE = 'Asia/Shanghai'
/** Share of keys that get {@link PRIMARY_TIME_ZONE}. */
export const PRIMARY_SHARE = 0.8
/** The other zones, picked with equal weight. Order is part of the contract. */
export const OTHER_TIME_ZONES: readonly string[] = [
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Singapore',
  'UTC',
]

/**
 * The zone for `key`: the first 8 bytes of SHA-256(key) as two big-endian
 * uint32; the first decides primary vs other (below PRIMARY_SHARE · 2^32), the
 * second picks among the others.
 */
export function pickTimeZone(key: string): string {
  const digest = createHash('sha256').update(key, 'utf8').digest()
  if (digest.readUInt32BE(0) < PRIMARY_SHARE * 2 ** 32) return PRIMARY_TIME_ZONE
  return OTHER_TIME_ZONES[digest.readUInt32BE(4) % OTHER_TIME_ZONES.length]!
}
