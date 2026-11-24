import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

/**
 * logbook through the engine's own host: each `on` here stands for the engine beneath the plugin,
 * with a file system in memory in place of `$.fs`.
 */

const FOLDER = '/work/app'
const HOME = '/Users/me'
const PROJECT_DIR = `${FOLDER}/.claude/logbook/memory`
const PERSONAL_DIR = `${HOME}/.claude/logbook/memory`

const file = (id: string, kind: string, layer: string, text: string, status = 'active') =>
  `---\nid: ${id}\nkind: ${kind}\nlayer: ${layer}\nstatus: ${status}\nsensitivity: normal\nsource: manual\ncreated: 2026-11-20T10:00:00.000Z\nupdated: 2026-11-20T10:00:00.000Z\n---\n\n${text}\n`

function world(on: On, seed: Record<string, string>) {
  const files = new Map(Object.entries(seed))
  mock.env(on, { HOME })
  mock.store(on)
  on('session.root', () => ({ value: FOLDER }))
  on('session.cwd', () => ({ value: FOLDER }))
  on('fs.exists', (_, e) => ({ value: [...files.keys()].some(p => p === e.path || p.startsWith(`${e.path}/`)) }))
  on('fs.list', (_, e) => ({
    value: [...files.keys()]
      .filter(p => p.startsWith(`${e.path}/`) && !p.slice(e.path.length + 1).includes('/'))
      .map(p => ({ name: p.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: t }
  })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__logbook__${e.name}` } }))
  on('command.register', () => ({ value: { command: 'memory' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [{ id: 'core', text: 'core prompt', scope: 'shared' as const }] }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  return files
}

const SEED = {
  [`${PROJECT_DIR}/20261120-100000-aaaa.md`]: file('20261120-100000-aaaa', 'constraint', 'project', 'Use pnpm, never npm, in this repo'),
  [`${PROJECT_DIR}/20261120-100001-bbbb.md`]: file('20261120-100001-bbbb', 'fact', 'project', 'Invoices are generated nightly by the billing worker'),
  [`${PROJECT_DIR}/20261120-100002-cccc.md`]: file('20261120-100002-cccc', 'constraint', 'project', 'Old rule nobody follows', 'revoked'),
  [`${PERSONAL_DIR}/20261120-100003-dddd.md`]: file('20261120-100003-dddd', 'preference', 'personal', 'Prefers short answers with the result first'),
}

const START = { cwd: FOLDER, surface: 'terminal', isInteractive: true } as const
const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never

test('the standing pack reaches the system prompt with both layers, and nothing revoked', async ($, on) => {
  world(on, SEED)
  await $.session.start(START)
  const r = await $.prompt.compose(COMPOSE)
  const mine = r.sections.find(s => s.id === 'logbook:memory')
  expect(mine?.scope).toBe('session')
  expect(mine?.text).toContain('Use pnpm, never npm')
  expect(mine?.text).toContain('Prefers short answers')
  expect(mine?.text).not.toContain('Old rule')
  // A fact is recalled on demand, not standing.
  expect(mine?.text).not.toContain('Invoices')
})

test('a prompt about billing gets the matching memory beside it', async ($, on) => {
  world(on, SEED)
  await $.session.start(START)
  const r = await $.prompt.submit({ text: 'when does the billing worker generate invoices?', wait: false } as never)
  const ctx = (r as { context?: readonly string[] }).context ?? []
  expect(ctx.join('\n')).toContain('<logbook-recall>')
  expect(ctx.join('\n')).toContain('Invoices are generated nightly')
})

test('an unrelated prompt gets no recall block', async ($, on) => {
  world(on, SEED)
  await $.session.start(START)
  const r = await $.prompt.submit({ text: 'rename this variable', wait: false } as never)
  expect((r as { context?: readonly string[] }).context ?? []).toEqual([])
})

test('remember writes a file, supersedes, and recall finds it', async ($, on) => {
  const files = world(on, SEED)
  await $.session.start(START)
  const saved = await $.tool.call({ tool: 'mcp__logbook__remember', text: 'Use bun, not pnpm, in this repo', kind: 'constraint', supersedes: '20261120-100000-aaaa' } as never)
  expect(String((saved as { result?: unknown }).result)).toContain('supersedes 20261120-100000-aaaa')
  const old = files.get(`${PROJECT_DIR}/20261120-100000-aaaa.md`) ?? ''
  expect(old).toContain('status: superseded')
  const written = [...files.keys()].filter(p => p.startsWith(PROJECT_DIR) && !(p in SEED))
  expect(written.length).toBe(1)
  const found = await $.tool.call({ tool: 'mcp__logbook__recall', query: 'bun' } as never)
  expect(String((found as { result?: unknown }).result)).toContain('Use bun, not pnpm')
})

test('a preference goes to the personal layer by default', async ($, on) => {
  const files = world(on, SEED)
  await $.session.start(START)
  await $.tool.call({ tool: 'mcp__logbook__remember', text: 'Likes diagrams for architecture questions', kind: 'preference' } as never)
  expect([...files.keys()].some(p => p.startsWith(PERSONAL_DIR) && !(p in SEED))).toBe(true)
})

test('mode off keeps memory out of the prompt', async ($, on) => {
  world(on, { ...SEED, [`${FOLDER}/.claude/logbook/mode`]: 'off' })
  await $.session.start(START)
  const r = await $.prompt.compose(COMPOSE)
  expect(r.sections.some(s => s.id === 'logbook:memory')).toBe(false)
})

test('/memory capture writes what the model proposes, skips duplicates, and undo takes the batch back', async ($, on) => {
  const files = world(on, SEED)
  const said = 'We decided to keep invoices in Postgres and never in S3, because finance needs SQL access. '.repeat(10)
  on('session.messages', () => ({ value: [{ role: 'user' as const, text: said, toolUses: [] }, { role: 'assistant' as const, text: 'Understood, Postgres it is.', toolUses: [] }] }))
  on('session.redact', (_, e) => ({ value: (e as { text: string }).text }))
  on('ui.toast', () => ({ value: undefined }))
  let asked = ''
  on('model.complete', (_, e) => {
    asked = String((e as { prompt: unknown }).prompt)
    return {
      value: {
        isAnswered: true as const,
        text: '{"memories":[{"text":"Invoices are stored in Postgres, never S3, because finance needs SQL access","kind":"decision","layer":"project"},{"text":"use pnpm never npm in this repo","kind":"constraint","layer":"project"}]}',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  await $.session.start(START)
  const out = await $.command.run({ command: 'memory', args: 'capture' } as never)
  const text = String((out as { text?: string }).text)
  expect(asked).toContain('<existing-memories>')
  expect(text).toContain('Captured 1')
  expect(text).toContain('skipped 1')
  const added = [...files.keys()].filter(p => !(p in SEED) && p.startsWith(PROJECT_DIR))
  expect(added.length).toBe(1)
  expect(files.get(added[0] ?? '')).toContain('source: capture')
  const undo = await $.command.run({ command: 'memory', args: 'undo' } as never)
  expect(String((undo as { text?: string }).text)).toContain('Revoked 1')
  expect(files.get(added[0] ?? '')).toContain('status: revoked')
})
