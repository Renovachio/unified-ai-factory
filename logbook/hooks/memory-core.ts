/**
 * Pure memory model: kinds, lifecycle, file format. No `$` here, so it is tested without an engine.
 *
 * Memories are auto-approved: a captured memory is `active` at once, and the person prunes later
 * (revoke, undo, edit the file). A newer memory that replaces an older one supersedes it, and both
 * files keep the link, so nothing is silently lost.
 */

export const KINDS = ['decision', 'requirement', 'constraint', 'fact', 'preference', 'note'] as const
export type Kind = (typeof KINDS)[number]

export const STATUSES = ['active', 'superseded', 'revoked'] as const
export type Status = (typeof STATUSES)[number]

/** project: this folder's memory, kept in the folder. personal: yours, applied in every folder. */
export const LAYERS = ['project', 'personal'] as const
export type Layer = (typeof LAYERS)[number]

/** restricted memories are kept but never injected into a prompt. */
export const SENSITIVITIES = ['normal', 'restricted'] as const
export type Sensitivity = (typeof SENSITIVITIES)[number]

export type Memory = {
  id: string
  kind: Kind
  layer: Layer
  status: Status
  sensitivity: Sensitivity
  text: string
  /** Where it came from: `remember` (the model or the person said so), `capture` (extracted), `manual`. */
  source: 'remember' | 'capture' | 'manual'
  /** A short excerpt of what it was taken from, when captured. */
  evidence?: string
  /** The capture batch it came from, so `undo` can take a whole batch back. */
  batch?: string
  created: string
  updated: string
  supersedes?: string
  supersededBy?: string
  reason?: string
}

export const MAX_TEXT = 600

/** Legal moves. `active` is the only usable status; the others are history. */
const MOVES: Record<Status, readonly Status[]> = {
  active: ['superseded', 'revoked'],
  superseded: ['active'],
  revoked: ['active'],
}

export function canMove(from: Status, to: Status): boolean {
  return MOVES[from].includes(to)
}

export const isUsable = (m: Memory) => m.status === 'active'
export const isInjectable = (m: Memory) => isUsable(m) && m.sensitivity !== 'restricted'

const pick = <T extends string>(all: readonly T[], v: unknown): T | undefined =>
  typeof v === 'string' && (all as readonly string[]).includes(v.trim().toLowerCase()) ? (v.trim().toLowerCase() as T) : undefined

export const asKind = (v: unknown) => pick(KINDS, v)
export const asLayer = (v: unknown) => pick(LAYERS, v)
const asStatus = (v: unknown) => pick(STATUSES, v)
const asSensitivity = (v: unknown) => pick(SENSITIVITIES, v)

/** One line, trimmed, at most MAX_TEXT characters; undefined when nothing is left. */
export function cleanText(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.replace(/\s+/g, ' ').trim()
  if (!t) return undefined
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t
}

/** `20261124-153012-ab12`: sortable by time, unique enough for one person's files. */
export function newId(now: Date, rand: () => number = Math.random): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  const tail = Array.from({ length: 4 }, () => '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(rand() * 36)]).join('')
  return `${stamp}-${tail}`
}

export const ID_RE = /^\d{8}-\d{6}-[0-9a-z]{4}$/

export function makeMemory(x: {
  text: string
  kind: Kind
  layer: Layer
  source: Memory['source']
  now: Date
  rand?: () => number
  evidence?: string
  batch?: string
  sensitivity?: Sensitivity
  supersedes?: string
}): Memory {
  const at = x.now.toISOString()
  const m: Memory = {
    id: newId(x.now, x.rand),
    kind: x.kind,
    layer: x.layer,
    status: 'active',
    sensitivity: x.sensitivity ?? 'normal',
    text: x.text,
    source: x.source,
    created: at,
    updated: at,
  }
  if (x.evidence) m.evidence = x.evidence
  if (x.batch) m.batch = x.batch
  if (x.supersedes) m.supersedes = x.supersedes
  return m
}

/** Moves a memory to `to`, or throws when the move is not legal. Returns a new value. */
export function move(m: Memory, to: Status, now: Date, extra: { reason?: string; supersededBy?: string } = {}): Memory {
  if (!canMove(m.status, to)) throw new Error(`memory ${m.id} cannot move from ${m.status} to ${to}`)
  const next: Memory = { ...m, status: to, updated: now.toISOString() }
  if (extra.reason) next.reason = extra.reason
  if (to === 'superseded' && extra.supersededBy) next.supersededBy = extra.supersededBy
  if (to === 'active') { delete next.supersededBy; delete next.reason }
  return next
}

// ── file format ───────────────────────────────────────────
// One memory per file: `---` front matter of `key: value` lines (values JSON-quoted when they need it),
// then the text as the body. Hand-editable; unknown keys are ignored; a broken file is skipped, not fatal.

const FIELDS = ['id', 'kind', 'layer', 'status', 'sensitivity', 'source', 'created', 'updated', 'supersedes', 'supersededBy', 'batch', 'reason', 'evidence'] as const

const quote = (v: string) => (/^[\w.:@/+-]*$/.test(v) && v !== '' ? v : JSON.stringify(v))

export function toFile(m: Memory): string {
  const lines = ['---']
  for (const k of FIELDS) {
    const v = m[k]
    if (v !== undefined && v !== '') lines.push(`${k}: ${quote(String(v))}`)
  }
  lines.push('---', '', m.text, '')
  return lines.join('\n')
}

function unquote(v: string): string | undefined {
  const t = v.trim()
  if (!t.startsWith('"')) return t
  try {
    const s: unknown = JSON.parse(t)
    return typeof s === 'string' ? s : undefined
  } catch {
    return undefined
  }
}

/** Parses a memory file; undefined when it is not one (missing or invalid required fields). */
export function fromFile(text: string, layerHint?: Layer): Memory | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return undefined
  const f: Record<string, string> = {}
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const v = unquote(line.slice(i + 1))
    if (v !== undefined) f[line.slice(0, i).trim()] = v
  }
  const body = cleanText(m[2] ?? '')
  const kind = asKind(f.kind)
  const layer = asLayer(f.layer) ?? layerHint
  const status = asStatus(f.status)
  if (!f.id || !ID_RE.test(f.id) || !body || !kind || !layer || !status) return undefined
  const source = f.source === 'remember' || f.source === 'capture' || f.source === 'manual' ? f.source : 'manual'
  const out: Memory = {
    id: f.id,
    kind,
    layer,
    status,
    sensitivity: asSensitivity(f.sensitivity) ?? 'normal',
    text: body,
    source,
    created: f.created ?? '',
    updated: f.updated ?? f.created ?? '',
  }
  for (const k of ['supersedes', 'supersededBy', 'batch', 'reason', 'evidence'] as const) if (f[k]) out[k] = f[k]
  return out
}

export const fileName = (m: Pick<Memory, 'id'>) => `${m.id}.md`

/** One line for lists: `[decision·project] text  (id)`. */
export function line(m: Memory): string {
  const flag = m.status === 'active' ? '' : ` (${m.status})`
  return `[${m.kind}·${m.layer}] ${m.text}${flag}  ‹${m.id}›`
}
