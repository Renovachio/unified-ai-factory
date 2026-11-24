/**
 * The logbook: both layers' memories in memory, their files on disk, and the search index.
 * Everything goes through `Io`, so it is tested without an engine.
 *
 * Project memories live in the folder (`<folder>/.claude/logbook/memory/`), personal ones in
 * `~/.claude/logbook/memory/`. A folder is just a folder: it counts as a git repo only if the
 * person says so, which changes nothing here.
 */

import type { Plan } from './extract-core'
import type { Index } from './index-core'
import { buildIndex, search } from './index-core'
import type { Layer, Memory, Status } from './memory-core'
import { fileName, fromFile, move, toFile } from './memory-core'

export type Entry = { name: string; kind: string }
export type Io = {
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<void>
  list(path: string): Promise<Entry[]>
  exists(path: string): Promise<boolean>
}

export const PROJECT_SUBDIR = '.claude/logbook/memory'
export const PERSONAL_SUBDIR = '.claude/logbook/memory'

export type Dirs = Partial<Record<Layer, string>>

export function dirsFor(folder: string | undefined, home: string | undefined): Dirs {
  const d: Dirs = {}
  if (folder) d.project = `${folder.replace(/\/+$/, '')}/${PROJECT_SUBDIR}`
  if (home) d.personal = `${home.replace(/\/+$/, '')}/${PERSONAL_SUBDIR}`
  // The home folder used as a project would make both layers one folder: keep it personal only.
  if (d.project && d.project === d.personal) delete d.project
  return d
}

export class Book {
  private byId = new Map<string, Memory>()
  private ix: Index = buildIndex([])
  /** Files that would not parse, for /memory doctor. */
  broken: string[] = []

  constructor(private io: Io, readonly dirs: Dirs) {}

  async load(): Promise<void> {
    this.byId.clear()
    this.broken = []
    for (const layer of ['personal', 'project'] as const) {
      const dir = this.dirs[layer]
      if (!dir || !(await this.io.exists(dir).catch(() => false))) continue
      const entries = await this.io.list(dir).catch(() => [] as Entry[])
      for (const e of entries) {
        if (e.kind !== 'file' || !e.name.endsWith('.md')) continue
        const path = `${dir}/${e.name}`
        const m = fromFile(await this.io.read(path).catch(() => ''), layer)
        // The layer is where the file sits, whatever it says: moving a file moves the memory.
        if (m) this.byId.set(m.id, { ...m, layer })
        else this.broken.push(path)
      }
    }
    this.reindex()
  }

  private reindex() {
    this.ix = buildIndex([...this.byId.values()])
  }

  all(): Memory[] {
    return [...this.byId.values()].sort((a, b) => b.created.localeCompare(a.created))
  }

  get(id: string): Memory | undefined {
    return this.byId.get(id)
  }

  index(): Index {
    return this.ix
  }

  hasLayer(layer: Layer): boolean {
    return this.dirs[layer] !== undefined
  }

  private async put(m: Memory): Promise<void> {
    const dir = this.dirs[m.layer]
    if (!dir) throw new Error(`no ${m.layer} memory folder in this session`)
    await this.io.write(`${dir}/${fileName(m)}`, toFile(m))
    this.byId.set(m.id, m)
  }

  /** Writes new memories and the superseded ones a plan names, then reindexes once. */
  async apply(p: Pick<Plan, 'add' | 'supersede'>, now: Date): Promise<Memory[]> {
    const written: Memory[] = []
    for (const m of p.add) {
      // A personal memory with no personal folder falls back to the project, and the other way round.
      const layer: Layer = this.hasLayer(m.layer) ? m.layer : m.layer === 'personal' ? 'project' : 'personal'
      if (!this.hasLayer(layer)) continue
      const placed = { ...m, layer }
      await this.put(placed)
      written.push(placed)
    }
    for (const [oldId, newId] of p.supersede) {
      const old = this.byId.get(oldId)
      if (old?.status === 'active' && this.byId.has(newId)) await this.put(move(old, 'superseded', now, { supersededBy: newId }))
    }
    this.reindex()
    return written
  }

  /** Moves one memory to `to` (revoke, restore). Returns the updated memory, or a reason it could not. */
  async setStatus(id: string, to: Status, now: Date, reason?: string): Promise<Memory | string> {
    const m = this.byId.get(id)
    if (!m) return `No memory ${id}.`
    try {
      const next = move(m, to, now, { reason })
      await this.put(next)
      // Restoring a memory that superseded nothing is simple; revoking one that superseded another brings that one back.
      if (to === 'revoked' && m.supersedes) {
        const prev = this.byId.get(m.supersedes)
        if (prev?.status === 'superseded' && prev.supersededBy === m.id) await this.put(move(prev, 'active', now))
      }
      this.reindex()
      return next
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  /** The newest capture batch that still has an active memory, or undefined. */
  lastBatch(): string | undefined {
    const withBatch = this.all().filter(m => m.batch && m.status === 'active')
    return withBatch[0]?.batch
  }

  search(query: string, includeInactive = false, limit = 10) {
    return search(this.ix, query, { limit, keep: includeInactive ? undefined : m => m.status === 'active' })
  }
}
