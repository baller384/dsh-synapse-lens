// Local-only visual harness for the insight panels. It serves the real
// app.js/styles.css with a fixture workspace, so the canvas can be screenshotted
// in a headless browser without starting a DSH instance.
//
//   node dev/mock-server.mjs [port]
//
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyModelReview, buildRetrospective } from '../retrospective.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const port = Number(process.argv[2] ?? 6123)

const threads = [
  {
    id: 't1',
    parentId: null,
    dshSessionId: 'session-a',
    dshSessionTitle: '画布洞察面板',
    title: '画布洞察面板',
    color: '#0f766e',
    position: { x: 86, y: 82 },
    messages: [
      { id: 'm1', kind: 'user', text: '帮我把这个非线性对话画布扩展一下，在每个节点旁边加三个可展开的小框体：主旨意图、当前行为风险、对应更改文件。', sourceSeq: 1, at: '2026-11-01T09:00:00Z' },
      { id: 'm2', kind: 'assistant', text: '可以。先梳理画布现有的卡片结构，再把三块信息作为节点挂件渲染，数据由宿主从已提交的会话事件里推导。', sourceSeq: 2, at: '2026-11-01T09:01:00Z', process: [{ callId: 'c1', name: 'read' }, { callId: 'c2', name: 'grep' }] },
      { id: 'm3', kind: 'user', text: '主旨意图这一块不要只用关键词，还要把用户的约束条件提炼出来。', sourceSeq: 3, at: '2026-11-01T09:04:00Z' },
      { id: 'm4', kind: 'assistant', text: '已改成“目标句 + 约束标签”的结构，约束来自用户原话里“必须/不要/只能”这类句式。', sourceSeq: 4, at: '2026-11-01T09:05:00Z', process: [{ callId: 'c3', name: 'edit' }] },
    ],
  },
  {
    id: 't2',
    parentId: 't1',
    sourceSeedLength: 5,
    dshSessionId: 'session-b',
    dshSessionTitle: '改用展开面板',
    title: '改用展开面板',
    color: '#2563eb',
    position: { x: 816, y: 400 },
    messages: [
      { id: 'm5', kind: 'user', text: '改用展开面板而不是弹窗，并补上暗色主题。', sourceSeq: 6, at: '2026-11-01T09:10:00Z' },
      { id: 'm6', kind: 'assistant', text: '面板会贴着卡片下沿展开，空间不足时自动翻到上方；暗色样式跟着 synapse:theme 走。', sourceSeq: 7, at: '2026-11-01T09:11:00Z', process: [{ callId: 'c4', name: 'write' }, { callId: 'c5', name: 'pwsh' }] },
    ],
  },
  {
    id: 't3',
    parentId: 't1',
    sourceSeedLength: 5,
    dshSessionId: 'session-c',
    dshSessionTitle: '性能评估',
    title: '性能评估',
    color: '#be123c',
    position: { x: 86, y: 718 },
    messages: [
      { id: 'm7', kind: 'user', text: '评估一下这个改动对画布性能的影响，至少要给出首屏与滚动两个数字。', sourceSeq: 1, at: '2026-11-01T10:00:00Z' },
      { id: 'm8', kind: 'assistant', text: '首屏多一次 /insights 请求，按线程合并；滚动阶段只读缓存，不重复请求。', sourceSeq: 2, at: '2026-11-01T10:02:00Z', process: [{ callId: 'c6', name: 'web_search' }] },
    ],
  },
]

const insightByThread = {
  t1: {
    turns: {
      1: {
        seq: 1,
        intent: { goal: '在画布每个节点旁增加三块可展开的小框体', type: 'build', typeLabel: '实现功能', constraints: ['三块分别对应主旨意图、当前行为风险、对应更改文件'], questionPreview: threads[0].messages[0].text, basis: '按用户原话与关键词推断', confidence: 'medium' },
        risk: { score: 34, level: 'medium', label: '中', summary: '2 次编辑 · 1 条命令', reasons: [{ label: '修改文件', detail: 'src/canvas/card.ts', weight: 12 }, { label: '执行命令', detail: 'pnpm test', weight: 18 }], basis: '按工具类型、命令内容与路径位置估算' },
        files: [{ path: 'src/canvas/card.ts', displayPath: 'src/canvas/card.ts', op: 'modify', outside: false, additions: 42, deletions: 6 }, { path: 'src/canvas/insight.ts', displayPath: 'src/canvas/insight.ts', op: 'write', outside: false, additions: 128, deletions: 0 }],
        stats: { toolCount: 4, fileCount: 2, failed: false, durationMs: 64_000, tools: [{ name: 'edit', count: 2 }, { name: 'read', count: 1 }, { name: 'grep', count: 1 }] },
      },
      3: {
        seq: 3,
        intent: { goal: '把用户约束条件提炼进主旨意图', type: 'refactor', typeLabel: '重构优化', constraints: ['不要只用关键词'], questionPreview: threads[0].messages[2].text, basis: '按用户原话与关键词推断', confidence: 'medium' },
        risk: { score: 61, level: 'critical', label: '极高', summary: '1 次编辑 · 1 条命令', reasons: [{ label: '破坏性删除或格式化', detail: 'Remove-Item -Recurse .cache', weight: 55 }, { label: '修改文件', detail: 'src/insight/intent.ts', weight: 12 }], basis: '按工具类型、命令内容与路径位置估算' },
        files: [{ path: 'src/insight/intent.ts', displayPath: 'src/insight/intent.ts', op: 'modify', outside: false, additions: 18, deletions: 4 }],
        stats: { toolCount: 1, fileCount: 1, failed: false, durationMs: 12_000, tools: [{ name: 'edit', count: 1 }] },
      },
    },
    byIndex: [],
  },
  t2: {
    turns: {
      6: {
        seq: 6,
        intent: { goal: '把弹窗改成贴卡展开面板并补暗色主题', type: 'build', typeLabel: '实现功能', constraints: ['不要弹窗'], questionPreview: threads[1].messages[0].text, basis: '按用户原话与关键词推断', confidence: 'medium' },
        risk: { score: 72, level: 'critical', label: '极高', summary: '3 个文件 · 1 条命令', reasons: [{ label: '破坏性删除或格式化', detail: 'rm -rf dist && pnpm build', weight: 55 }, { label: '执行命令', detail: 'rm -rf dist && pnpm build', weight: 18 }], basis: '按工具类型、命令内容与路径位置估算' },
        files: [{ path: 'src/canvas/panel.ts', displayPath: 'src/canvas/panel.ts', op: 'modify', outside: false, additions: 86, deletions: 21 }, { path: 'src/canvas/panel.css', displayPath: 'src/canvas/panel.css', op: 'write', outside: false, additions: 204, deletions: 0 }, { path: 'C:\\Users\\demo\\notes.md', displayPath: 'C:/Users/demo/notes.md', op: 'delete', outside: true, additions: 0, deletions: 0 }],
        stats: { toolCount: 5, fileCount: 3, failed: false, durationMs: 185_000, tools: [{ name: 'write', count: 2 }, { name: 'pwsh', count: 1 }] },
      },
    },
    byIndex: [],
  },
  t3: {
    turns: {
      1: {
        seq: 1,
        intent: { goal: '评估洞察改动对画布性能的影响', type: 'analyze', typeLabel: '调研分析', constraints: ['至少要给出首屏与滚动两个数字'], questionPreview: threads[2].messages[0].text, basis: '按用户原话与关键词推断', confidence: 'high' },
        risk: { score: 80, level: 'critical', label: '极高', summary: '1 条命令', reasons: [{ label: '破坏性删除或格式化', detail: 'git reset --hard', weight: 55 }, { label: '执行命令', detail: 'git reset --hard', weight: 18 }], basis: '按工具类型、命令内容与路径位置估算' },
        files: [],
        stats: { toolCount: 1, fileCount: 0, failed: true, durationMs: 9_000, tools: [{ name: 'web_search', count: 1 }] },
      },
    },
    byIndex: [],
  },
}

const workspace = {
  id: 'w1',
  kind: 'dsh',
  cwd: 'C:\\work\\synapse',
  title: 'synapse',
  createdAt: '2026-11-01T08:00:00Z',
  updatedAt: '2026-11-01T10:02:00Z',
  deletedCards: [],
  threads,
}

const retroFixture = buildRetrospective({
  threads: threads.map(thread => ({ ...thread, insight: insightByThread[thread.id] ?? { turns: {}, byIndex: [] } })),
  activeThreadId: 't2',
  workspaceId: 'w1',
})
applyModelReview(retroFixture, {
  goal: '给画布节点加上意图、风险、文件洞察，并用行动分数复盘实现路径',
  steps: [
    { id: 't1:turn:1', impact: 30, reason: '先锁定三块面板的信息结构' },
    { id: 't1:turn:3', impact: 5, reason: '补约束提炼，但风险动作偏多' },
    { id: 't2:turn:6', impact: 25, reason: '把弹窗改成贴卡面板，收束体验' },
    { id: 't3:turn:1', impact: -45, reason: '性能评估没有落到文件产出，且执行了危险命令' },
  ],
  prompt: {
    verdict: '目标清楚，但首轮没有写验收条件，导致中途补约束、补暗色主题。',
    issues: ['首轮只说了“加三个小框体”，没有定义每个框体回答什么问题。', '没有要求先复述计划，探索步骤占了近一半。'],
    rewrite: '目标：在 Synapse 画布每张卡片下方增加“意图 / 风险 / 文件”三格洞察，点击展开面板。\n约束：不改动 DSH 原生会话与数据文件；浅色/深色都要可用。\n验收：给出截图与构建/测试通过结果，并说明改了哪些文件。\n先复述目标与计划，确认后再执行。',
    next: ['首轮先写“完成时我能看到什么”，再写约束。', '要求模型先复述计划，再动手。', '把“顺便做”的项拆成下一轮。'],
  },
}, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })

const page = () => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synapse Lens preview</title><link rel="stylesheet" href="/synapse/styles.css?v=${Date.now()}"></head><body><div id="app"></div><script src="/synapse/app.js?v=${Date.now()}"></script><script src="/demo.js?v=${Date.now()}"></script></body></html>`

const demo = `
const params = new URLSearchParams(location.search)
if (params.get('theme') === 'dark') document.documentElement.dataset.theme = 'dark'
const retro = params.get('retro') === '1'
const wanted = params.get('open') ?? 't2:6:risk'
const ignoreCardTarget = params.get('ignore') ?? params.get('delete')
if (ignoreCardTarget) {
  window.confirm = () => true
  setTimeout(() => {
    document.querySelector('.thread-card[data-card-id="' + CSS.escape(ignoreCardTarget) + '"] [data-action="ignore-card"]')?.click()
  }, 2500)
  if (params.get('soft') === '1') setTimeout(() => {
    document.querySelector('[data-action="mark-card"][data-mode="soft"][data-reason="misleading"]')?.click()
  }, 4200)
} else {
const timer = setInterval(() => {
  if (retro) {
    const button = document.querySelector('[data-action="open-retrospective"]')
    if (button === null) return
    clearInterval(timer)
    button.click()
    if (params.get('scroll') === 'end') setTimeout(() => {
      const scroll = document.querySelector('.retro-scroll')
      if (scroll !== null) scroll.scrollTop = scroll.scrollHeight
    }, 1400)
    if (params.get('focus') === '1') setTimeout(() => {
      document.querySelector('.retro-step')?.click()
    }, 1400)
    return
  }
  const [threadId, seq, section] = wanted.split(':')
  const cards = [...document.querySelectorAll('.thread-card')]
  const card = cards.find(node => node.dataset.thread === threadId && node.dataset.cardId === threadId + ':turn:' + seq)
  const chip = card?.querySelector('[data-section="' + section + '"]')
  if (chip === undefined) return
  clearInterval(timer)
  chip.click()
}, 250)
}
`

const staticFiles = {
  '/synapse/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/synapse/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/synapse/deepseek-mark.svg': ['deepseek-mark.svg', 'image/svg+xml'],
}

async function readBody(req) {
  let text = ''
  for await (const chunk of req) text += chunk
  try { return JSON.parse(text) } catch { return {} }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    if (path === '/synapse/' || path === '/synapse') {
      res.writeHead(path === '/synapse' ? 302 : 200, path === '/synapse' ? { location: '/synapse/' } : { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(path === '/synapse' ? '' : page())
    }
    if (path === '/demo.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      return res.end(demo)
    }
    if (staticFiles[path] !== undefined) {
      const [file, type] = staticFiles[path]
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      return res.end(await readFile(join(root, file)))
    }
    if (path === '/synapse/api/workspaces') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ workspaces: [{ id: 'w1', kind: 'dsh', cwd: workspace.cwd, title: workspace.title, createdAt: workspace.createdAt, updatedAt: workspace.updatedAt, threadCount: threads.length }] }))
    }
    if (path === '/synapse/api/workspaces/w1') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ workspace }))
    }
    const insights = /^\/synapse\/api\/threads\/([^/]+)\/insights$/.exec(path)
    if (insights !== null) {
      res.writeHead(200, { 'content-type': 'application/json' })
      const body = insightByThread[insights[1]] ?? { turns: {}, byIndex: [], generatedAt: new Date().toISOString() }
      return res.end(JSON.stringify({ threadId: insights[1], cwd: workspace.cwd, available: true, ...body }))
    }
    if (/^\/synapse\/api\/threads\/[^/]+\/retrospective$/.test(path)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(retroFixture))
    }
    const deleteCards = /^\/synapse\/api\/threads\/([^/]+)\/cards\/delete$/.exec(path)
    if (deleteCards !== null && req.method === 'POST') {
      const body = await readBody(req)
      workspace.deletedCards = (workspace.deletedCards ?? []).filter(entry => entry.rootCardId !== body.rootCardId)
      workspace.deletedCards.push({ rootCardId: body.rootCardId, threadId: deleteCards[1], cardIds: body.cardIds ?? [], cards: body.cards ?? [], mode: body.mode ?? 'hide', at: new Date().toISOString(), reason: body.reason ?? 'negative' })
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ deletedCards: workspace.deletedCards }))
    }
    const restoreCards = /^\/synapse\/api\/threads\/[^/]+\/cards\/restore$/.exec(path)
    if (restoreCards !== null && req.method === 'POST') {
      const body = await readBody(req)
      workspace.deletedCards = (workspace.deletedCards ?? []).filter(entry => entry.rootCardId !== body.rootCardId)
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ deletedCards: workspace.deletedCards }))
    }
    if (/^\/synapse\/api\/threads\/[^/]+\/full$/.test(path)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ messages: {} }))
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: String(error) }))
  }
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`mock ready http://127.0.0.1:${port}/synapse/?open=t2:6:risk\n`)
})
