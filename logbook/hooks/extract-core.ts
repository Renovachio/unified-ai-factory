/**
 * Capture: turn a stretch of conversation into typed memories. The model proposes; this file decides.
 * Its reply is untrusted text: it is parsed, every field validated, unknown or bad entries dropped,
 * near-duplicates of active memories skipped, and a `supersedes` honoured only for an active id we hold.
 */

import { overlap } from './index-core'
import type { Kind, Layer, Memory } from './memory-core'
import { asKind, asLayer, cleanText, isUsable, makeMemory } from './memory-core'

export type Turn = { role: 'user' | 'assistant'; text: string }

export const TRANSCRIPT_BUDGET = 40_000
export const MAX_CANDIDATES = 8
export const DUPLICATE_AT = 0.8

/** The conversation as plain lines, newest kept when over budget; tool output is left out (it is noise here). */
export function transcript(turns: readonly Turn[], budget = TRANSCRIPT_BUDGET): string {
  const lines: string[] = []
  let used = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    const t = turn?.text.trim()
    if (!turn || !t) continue
    const l = `${turn.role === 'user' ? 'PERSON' : 'ASSISTANT'}: ${t.length > 4000 ? `${t.slice(0, 4000)} …` : t}`
    if (used + l.length > budget) break
    lines.push(l)
    used += l.length + 1
  }
  return lines.reverse().join('\n')
}

export const SYSTEM = [
  'You extract durable memories from a coding conversation, for a tool that injects them into future sessions.',
  'A memory is one self-contained sentence someone could act on months later without the conversation.',
  'Keep only what stays true beyond this session: decisions and their reason, constraints, requirements, stable facts about the project, and the person\'s working preferences.',
  'Skip: task progress, what was just done, plans for the next minutes, guesses, anything already in the existing memories, secrets, credentials, tokens, and other people\'s personal data.',
  'kind is one of: decision, requirement, constraint, fact, preference, note.',
  'layer is "personal" for how the person likes to work in general (tools, style, communication); "project" for anything about this folder\'s code or product.',
  'If a new memory replaces or contradicts an existing one, set supersedes to that existing id.',
  `Return JSON only, no prose: {"memories":[{"text":"…","kind":"…","layer":"…","supersedes":"<id, optional>"}]}. At most ${MAX_CANDIDATES}. Return {"memories":[]} when nothing qualifies — that is the common case.`,
].join('\n')

export function prompt(convo: string, existing: readonly Memory[]): string {
  const known = existing.filter(isUsable).slice(0, 60).map(m => `- ‹${m.id}› [${m.kind}·${m.layer}] ${m.text}`)
  return [
    '<existing-memories>',
    known.length ? known.join('\n') : '(none)',
    '</existing-memories>',
    '<conversation>',
    convo,
    '</conversation>',
    'Extract the durable memories as JSON.',
  ].join('\n')
}

export type Candidate = { text: string; kind: Kind; layer: Layer; supersedes?: string }

/** The first JSON object in `reply`, validated into candidates; [] when there is none or it is malformed. */
export function parseReply(reply: string): Candidate[] {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let data: unknown
  try {
    data = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return []
  }
  const list = typeof data === 'object' && data !== null ? (data as { memories?: unknown }).memories : undefined
  if (!Array.isArray(list)) return []
  const out: Candidate[] = []
  for (const raw of list.slice(0, MAX_CANDIDATES)) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    const text = cleanText(r.text)
    const kind = asKind(r.kind)
    const layer = asLayer(r.layer)
    if (!text || !kind || !layer) continue
    const c: Candidate = { text, kind, layer }
    if (typeof r.supersedes === 'string' && r.supersedes.trim()) c.supersedes = r.supersedes.trim()
    out.push(c)
  }
  return out
}

export type Plan = {
  add: Memory[]
  /** Existing active memories each new one replaces: [old id, new id]. */
  supersede: [string, string][]
  skipped: { text: string; why: string }[]
}

/**
 * What to write: new memories, active, all in one batch. A candidate naming an active id we hold
 * supersedes it; one that says what an active memory already says is skipped; so is a repeat within the batch.
 */
export function plan(cands: readonly Candidate[], existing: readonly Memory[], x: { now: Date; batch: string; evidence?: string; rand?: () => number; source?: Memory['source'] }): Plan {
  const active = existing.filter(isUsable)
  const byId = new Map(active.map(m => [m.id, m]))
  const out: Plan = { add: [], supersede: [], skipped: [] }
  const taken = new Set<string>()
  for (const c of cands) {
    const old = c.supersedes ? byId.get(c.supersedes) : undefined
    if (old && taken.has(old.id)) { out.skipped.push({ text: c.text, why: `already superseded in this batch: ${old.id}` }); continue }
    const dup = active.find(m => m.id !== old?.id && overlap(m.text, c.text) >= DUPLICATE_AT)
    if (dup) { out.skipped.push({ text: c.text, why: `duplicate of ${dup.id}` }); continue }
    if (out.add.some(m => overlap(m.text, c.text) >= DUPLICATE_AT)) { out.skipped.push({ text: c.text, why: 'repeated in this batch' }); continue }
    const m = makeMemory({ text: c.text, kind: c.kind, layer: c.layer, source: x.source ?? 'capture', now: x.now, rand: x.rand, batch: x.batch, evidence: x.evidence, supersedes: old?.id })
    out.add.push(m)
    if (old) { out.supersede.push([old.id, m.id]); taken.add(old.id) }
  }
  return out
}
