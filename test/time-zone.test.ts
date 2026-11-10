import assert from 'node:assert/strict'
import { test } from 'node:test'
import { currentDateLine } from '../src/core/prompt.ts'
import { OTHER_TIME_ZONES, PRIMARY_TIME_ZONE, pickTimeZone } from '../src/core/time-zone.ts'

test('pickTimeZone: stable per key, mostly Asia/Shanghai, others from the list', () => {
  assert.equal(pickTimeZone('srch-a002-t1'), pickTimeZone('srch-a002-t1'))
  const counts = new Map<string, number>()
  for (let i = 0; i < 20000; i++) {
    const zone = pickTimeZone(`case-${i}-t1`)
    counts.set(zone, (counts.get(zone) ?? 0) + 1)
  }
  const primary = (counts.get(PRIMARY_TIME_ZONE) ?? 0) / 20000
  assert.ok(primary > 0.78 && primary < 0.82, `primary share ${primary}`)
  for (const zone of counts.keys()) assert.ok(zone === PRIMARY_TIME_ZONE || OTHER_TIME_ZONES.includes(zone), zone)
  for (const zone of OTHER_TIME_ZONES) assert.ok((counts.get(zone) ?? 0) > 400, `${zone} too rare`)
  for (const zone of [PRIMARY_TIME_ZONE, ...OTHER_TIME_ZONES]) assert.match(currentDateLine(0, zone), /^Current date: \d{4}-\d{2}-\d{2} \(.+, UTC[+-]\d{2}:\d{2}\)\.$/)
})

test('pickTimeZone: pinned values (qc.py mirrors this function)', () => {
  assert.deepEqual(['srch-a002-t1', 'case-8-t1', 'case-11-t1', 'case-14-t1', 'case-25-t1', 'case-37-t1'].map(pickTimeZone), PINNED)
})
const PINNED = ['Asia/Shanghai', 'Asia/Tokyo', 'Europe/London', 'America/New_York', 'Asia/Singapore', 'Europe/Berlin']
