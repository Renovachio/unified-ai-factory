import type { EngineInterface, Register, SessionMessage } from 'claude-code'
import { Book, dirsFor } from './book'
import type { Io } from './book'
import { parseReply, plan, prompt as capturePrompt, SYSTEM, transcript } from './extract-core'
import type { Turn } from './extract-core'
import { asKind, asLayer, cleanText, ID_RE, KINDS, line, newId } from './memory-core'
import { recall, recallBlock, SECTION_ID, standing, standingSection } from './pack-core'

/**
 * logbook's wiring. The engine allows one unmatched hook per event per plugin, so each event has one hook
 * here. Every hook falls through to next(e) on error: memory is help, and must never break a turn.
 *
 * - prompt.compose: the standing pack as a session-scope system-prompt section.
 * - prompt.submit: memories matching the prompt, attached beside it (never shown, cache untouched).
 * - session.compact: capture before the conversation is summarised away.
 * - turn.complete: capture every CAPTURE_EVERY main-loop turns.
 * - tools remember / recall / forget, and /memory.
 */

const MODE_FILE = '.claude/logbook/mode'
const CAPTURE_EVERY = 20
const MIN_CONVO = 600
const EXTRACT_MODEL = 'haiku'

type Mode = 'on' | 'read' | 'off'
const asMode = (v: unknown): Mode | undefined => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return s === 'on' || s === 'read' || s === 'off' ? s : undefined
}

// Module state: rebuilt from disk at session.start (a reload runs it again).
let book: Book | undefined
let folder: string | undefined
let turnsSince = 0
let seenUuid: string | undefined
let capturing = false
/** Ids recalled beside a prompt this session, newest last, for /memory. */
let inPlay: string[] = []

function engineIo($: EngineInterface): Io {
  return {
    read: p => $.fs.read(p) as Promise<string>,
    write: (p, t) => $.fs.write(p, t),
    list: async p => (await $.fs.list(p)).map(e => ({ name: e.name, kind: e.kind })),
    exists: p => $.fs.exists(p),
  }
}

async function readMode($: EngineInterface): Promise<Mode> {
  if (folder) {
    const f = asMode(await $.fs.read(`${folder}/${MODE_FILE}`).catch(() => undefined))
    if (f) return f
  }
  try { return asMode(await $.store.get('mode')) ?? 'on' } catch { return 'on' }
}

async function open($: EngineInterface): Promise<Book> {
  folder = await $.session.root().catch(() => $.session.cwd()).catch(() => undefined)
  const home = await $.env.get('HOME').catch(() => undefined)
  const b = new Book(engineIo($), dirsFor(folder, home))
  await b.load()
  book = b
  turnsSince = 0
  seenUuid = undefined
  inPlay = []
  return b
}

const text = (s: string) => ({ result: s }) as never
const deny = (s: string) => ({ deny: s }) as never
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

function toTurns(ms: readonly SessionMessage[]): Turn[] {
  return ms.filter(m => m.text.trim()).map(m => ({ role: m.role, text: m.text }))
}

/** Extracts memories from `turns` with a cheap model and writes them. Never throws; one capture at a time. */
async function capture($: EngineInterface, turns: readonly Turn[], why: string): Promise<string> {
  const b = book
  if (!b) return 'logbook is not open in this session.'
  if (capturing) return 'A capture is already running.'
  const convo = transcript(turns)
  if (convo.length < MIN_CONVO) return 'Not enough conversation to capture yet.'
  capturing = true
  try {
    const safe = await $.session.redact(convo)
    const r = await $.model.complete({ model: EXTRACT_MODEL, system: SYSTEM, prompt: capturePrompt(safe, b.all()), maxTokens: 1500, effort: 'low', timeoutMs: 90_000 })
    if (!r.isAnswered) return `Capture failed (${r.reason}).`
    const now = new Date()
    const p = plan(parseReply(r.text), b.all(), { now, batch: `cap-${newId(now)}`, evidence: why })
    const written = await b.apply(p, now)
    if (written.length) $.ui.toast(`logbook: saved ${written.length} ${written.length === 1 ? 'memory' : 'memories'} · /memory undo takes them back`)
    const lines = written.map(m => `+ ${line(m)}`)
    const sup = p.supersede.map(([o, n]) => `~ ${o} superseded by ${n}`)
    return [`Captured ${written.length} (${why}); skipped ${p.skipped.length}.`, ...lines, ...sup].join('\n')
  } catch (err) {
    return `Capture failed: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    capturing = false
  }
}

/** Runs a capture outside the calling hook's dispatch, so it survives the hook returning. */
function captureLater($: EngineInterface, turns: readonly Turn[], why: string) {
  $.clock.after(1, () => { void capture($, turns, why) })
}

async function registerTools($: EngineInterface) {
  await $.tool.register({
    name: 'remember',
    description:
      'Saves a durable memory for future sessions: a decision, constraint, requirement, fact, preference or note, in one self-contained sentence. ' +
      'layer: "project" (this folder; the default) or "personal" (how the person works, in every folder). ' +
      'Pass supersedes with the old ‹id› when this replaces or corrects a memory. Never save secrets or other people\'s personal data.',
    inputSchema: {
      type: 'object',
      required: ['text', 'kind'],
      properties: {
        text: { type: 'string', description: 'One sentence that stands on its own' },
        kind: { type: 'string', enum: [...KINDS] },
        layer: { type: 'string', enum: ['project', 'personal'] },
        supersedes: { type: 'string', description: 'The ‹id› of the memory this replaces' },
      },
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'recall',
    description: 'Searches logbook memories (both layers) for a topic and returns the matching active ones with their ‹id›.',
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'forget',
    description: 'Revokes a memory by ‹id› when the person says it is wrong or no longer applies. It stays on disk as revoked and can be restored.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, reason: { type: 'string' } } },
    isDeferred: false,
  })
}

async function remember(args: Record<string, unknown>): Promise<string> {
  const b = book
  if (!b) return 'Error: logbook is not open in this session.'
  const t = cleanText(args.text)
  const kind = asKind(args.kind)
  if (!t || !kind) return 'Error: remember needs text and a kind (decision, requirement, constraint, fact, preference, note).'
  const layer = asLayer(args.layer) ?? (kind === 'preference' ? 'personal' : 'project')
  const supersedes = str(args.supersedes)?.trim()
  const now = new Date()
  const p = plan([{ text: t, kind, layer, supersedes }], b.all(), { now, batch: `rem-${newId(now)}`, source: 'remember' })
  if (!p.add.length) return `Not saved: ${p.skipped[0]?.why ?? 'nothing to save'}.`
  const [m] = await b.apply(p, now)
  if (!m) return `Not saved: no ${layer} memory folder in this session.`
  return `Saved ${line(m)}${p.supersede[0] ? ` (supersedes ${p.supersede[0][0]})` : ''}.`
}

function listText(all: boolean): string {
  const b = book
  if (!b) return 'logbook is not open in this session.'
  const ms = b.all().filter(m => all || m.status === 'active')
  if (!ms.length) return all ? 'No memories yet.' : 'No active memories yet. Say "remember …", or they are captured as you work.'
  const pinned = new Set(standing(b.all()).map(m => m.id))
  const out = [`${ms.length} ${all ? '' : 'active '}memories (★ standing, ◆ recalled this session):`]
  for (const m of ms.slice(0, 60)) out.push(`${pinned.has(m.id) ? '★' : inPlay.includes(m.id) ? '◆' : ' '} ${line(m)}`)
  if (ms.length > 60) out.push(`… and ${ms.length - 60} more; /memory search <words> narrows it.`)
  const d = b.dirs
  out.push('', `project: ${d.project ?? '(none)'}`, `personal: ${d.personal ?? '(none)'}`)
  if (b.broken.length) out.push(`unreadable files: ${b.broken.join(', ')}`)
  return out.join('\n')
}

const HELP = [
  '/memory               active memories (★ standing, ◆ recalled this session)',
  '/memory all           including superseded and revoked',
  '/memory search <q>    search both layers',
  '/memory forget <id>   revoke one        /memory restore <id>   bring it back',
  '/memory undo          revoke the newest capture batch',
  '/memory capture       capture from this conversation now',
  '/memory mode [on|read|off]   on: inject + capture · read: inject only · off: nothing',
  '/memory reload        re-read the memory files (after editing them by hand)',
].join('\n')

async function command($: EngineInterface, args: string): Promise<string> {
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  const arg = rest.join(' ').trim()
  const b = book ?? (await open($))
  const now = new Date()
  switch (verb.toLowerCase()) {
    case '': return listText(false)
    case 'all': return listText(true)
    case 'help': return HELP
    case 'search': {
      if (!arg) return 'Usage: /memory search <words>'
      const hits = b.search(arg, true)
      return hits.length ? hits.map(h => line(h.m)).join('\n') : `Nothing matches "${arg}".`
    }
    case 'forget':
    case 'revoke':
    case 'restore': {
      if (!ID_RE.test(arg)) return `Usage: /memory ${verb} <id>`
      const r = await b.setStatus(arg, verb === 'restore' ? 'active' : 'revoked', now, verb === 'restore' ? undefined : 'revoked by the person')
      return typeof r === 'string' ? r : `${verb === 'restore' ? 'Restored' : 'Revoked'} ${line(r)}`
    }
    case 'undo': {
      const batch = b.lastBatch()
      if (!batch) return 'No capture to undo.'
      const hit = b.all().filter(m => m.batch === batch && m.status === 'active')
      for (const m of hit) await b.setStatus(m.id, 'revoked', now, `undo ${batch}`)
      return [`Revoked ${hit.length} from ${batch}:`, ...hit.map(m => `- ${m.text}`), '/memory restore <id> brings one back.'].join('\n')
    }
    case 'capture': {
      const ms = await $.session.messages()
      return capture($, toTurns(ms), 'asked with /memory capture')
    }
    case 'mode': {
      const want = asMode(arg)
      if (!want) return `Mode is ${await readMode($)}.${folder ? ` A file ${MODE_FILE} in the folder pins it.` : ''}`
      await $.store.set('mode', want)
      return `Mode ${want}. The standing pack changes from the next session, /clear or compaction (the system prompt is cached).`
    }
    case 'reload': {
      await b.load()
      return `Reloaded ${b.all().length} memories.`
    }
    default: return HELP
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await open($).catch(() => undefined)
    await registerTools($).catch(() => undefined)
    await $.command.register({ name: 'memory', description: 'logbook memories: list, search, forget, undo, capture (/memory help)' }).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // /clear ends this conversation without a session.start after it: start the counters over.
  on('session.end', async ($, e, next) => {
    const r = await next(e)
    if (e.reason === 'clear') { turnsSince = 0; seenUuid = undefined; inPlay = [] }
    return r
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const b = book
    if (!b || (await readMode($)) === 'off') return r
    const sections = r.sections.filter(s => s.id !== SECTION_ID)
    sections.push({ id: SECTION_ID, text: standingSection(b.all()), scope: 'session' as const })
    return { sections }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const b = book
    if (!b || e.command || e.isMeta || (await readMode($)) === 'off') return next(e)
    const skip = new Set(standing(b.all()).map(m => m.id))
    const hits = recall(b.index(), e.text, skip)
    const block = recallBlock(hits)
    if (!block) return next(e)
    inPlay = [...inPlay.filter(id => !hits.some(h => h.id === id)), ...hits.map(h => h.id)].slice(-40)
    return next({ ...e, context: [...(e.context ?? []), block] })
  }).catch(($, e, next) => next(e))

  // Capture what is about to be summarised away. Main conversation only; precompute keeps nothing.
  on('session.compact', async ($, e, next) => {
    if (book && !e.agentId && e.trigger !== 'precompute' && (await readMode($)) === 'on') {
      captureLater($, toTurns(e.messages), `before ${e.trigger} compaction`)
      turnsSince = 0
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!book || (e as { agentId?: string }).agentId) return r
    turnsSince++
    if (turnsSince < CAPTURE_EVERY || capturing || (await readMode($)) !== 'on') return r
    turnsSince = 0
    const fresh = await $.session.messages(seenUuid ? { after: seenUuid } : { last: CAPTURE_EVERY * 4 })
    if ('deny' in fresh) { seenUuid = undefined; return r }
    seenUuid = fresh.at(-1)?.uuid ?? seenUuid
    captureLater($, toTurns(fresh), `every ${CAPTURE_EVERY} turns`)
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'memory' }, async ($, e) => ({ text: await command($, e.args) }))
    .catch(($, e) => ({ text: 'logbook: /memory failed.' }))

  on('tool.call', { tool: 'mcp__logbook__remember' }, async ($, e) => text(await remember(e as unknown as Record<string, unknown>)))
    .catch(() => deny('logbook: remember failed.'))

  on('tool.call', { tool: 'mcp__logbook__recall' }, async ($, e) => {
    const q = str((e as unknown as Record<string, unknown>).query)?.trim()
    if (!book) return text('logbook is not open in this session.')
    if (!q) return deny('recall needs a query.')
    const hits = book.search(q)
    for (const h of hits) if (!inPlay.includes(h.m.id)) inPlay.push(h.m.id)
    return text(hits.length ? hits.map(h => line(h.m)).join('\n') : `No memories match "${q}".`)
  }).catch(() => deny('logbook: recall failed.'))

  on('tool.call', { tool: 'mcp__logbook__forget' }, async ($, e) => {
    const a = e as unknown as Record<string, unknown>
    const id = str(a.id)?.trim() ?? ''
    if (!book) return text('logbook is not open in this session.')
    if (!ID_RE.test(id)) return deny('forget needs a memory ‹id›.')
    const r = await book.setStatus(id, 'revoked', new Date(), str(a.reason) ?? 'revoked at the person\'s request')
    return text(typeof r === 'string' ? r : `Revoked ${line(r)}`)
  }).catch(() => deny('logbook: forget failed.'))
}

