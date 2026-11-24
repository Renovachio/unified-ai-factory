/**
 * Lexical search over memories: tokens with a light English/Portuguese stem, ranked by BM25.
 * Built in memory from the files at session start; at one person's scale (hundreds to a few
 * thousand memories) that takes milliseconds, so there is no index file to keep in sync.
 */

import type { Memory } from './memory-core'

const STOP = new Set(
  (
    // English
    'the a an is are was were be been do does did where what which who how why when to of in on for and or it its this that ' +
    'these those with from by at as get i we you can should would could there any all now also just lets let me my our please ' +
    'so then than too very ok okay yes no not but if into out up down more some like make made use want need will shall have has had ' +
    // Portuguese
    'o os um uma uns umas de do da dos das em no na nos nas por para com sem que se e ou mas como mais menos muito ' +
    'ja não nao sim isso isto esse essa este esta ele ela eles elas eu tu nós nos vós voce você seu sua ao aos à às é ser foi são sao'
  ).split(' '),
)

/** Strips accents so "decisão" and "decisao" meet. */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')

/** A deliberately light stem: plural and common suffixes, English and Portuguese. Good enough to join variants. */
export function stem(w: string): string {
  if (w.length <= 4) return w
  for (const suf of ['amentos', 'imentos', 'amento', 'imento', 'ações', 'acoes', 'ação', 'acao', 'ations', 'ation', 'ments', 'ment', 'ings', 'ing', 'edly', 'ies', 'ed', 'es', 's']) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length)
  }
  return w
}

export function tokens(text: string): string[] {
  const out: string[] = []
  for (const raw of fold(text.toLowerCase()).split(/[^a-z0-9_]+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue
    out.push(stem(raw))
  }
  return out
}

export type Index = {
  docs: { m: Memory; tf: Map<string, number>; len: number }[]
  df: Map<string, number>
  avgLen: number
}

export function buildIndex(memories: readonly Memory[]): Index {
  const docs = memories.map(m => {
    const tf = new Map<string, number>()
    const ts = tokens(`${m.text} ${m.kind}`)
    for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1)
    return { m, tf, len: ts.length }
  })
  const df = new Map<string, number>()
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  const avgLen = docs.length ? docs.reduce((a, d) => a + d.len, 0) / docs.length : 0
  return { docs, df, avgLen }
}

export type Hit = { m: Memory; score: number }

/** BM25 (k1 1.2, b 0.75) over the memories that pass `keep`; best first, scores above 0 only. */
export function search(ix: Index, query: string, opts: { limit?: number; keep?: (m: Memory) => boolean } = {}): Hit[] {
  const q = [...new Set(tokens(query))]
  if (!q.length || !ix.docs.length) return []
  const n = ix.docs.length
  const k1 = 1.2
  const b = 0.75
  const hits: Hit[] = []
  for (const d of ix.docs) {
    if (opts.keep && !opts.keep(d.m)) continue
    let score = 0
    for (const t of q) {
      const f = d.tf.get(t)
      if (!f) continue
      const df = ix.df.get(t) ?? 0
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / (ix.avgLen || 1))))
    }
    if (score > 0) hits.push({ m: d.m, score })
  }
  hits.sort((a, b2) => b2.score - a.score || b2.m.updated.localeCompare(a.m.updated))
  return hits.slice(0, opts.limit ?? 10)
}

/** Share of the smaller token set found in the other: 1 means one says all the other says. For dedupe. */
export function overlap(a: string, b: string): number {
  const x = new Set(tokens(a))
  const y = new Set(tokens(b))
  if (!x.size || !y.size) return 0
  let both = 0
  for (const t of x) if (y.has(t)) both++
  return both / Math.min(x.size, y.size)
}
