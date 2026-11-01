import assert from 'node:assert/strict'
import test from 'node:test'
import { assessRisk, changedFiles, inferIntent, insightsFromEvents, insightsFromMessages } from '../insight.js'

const userEvent = (seq, text) => ({ seq, type: 'user/message', time: 1_000 * seq, data: { content: [{ type: 'text', text }] } })
const toolCall = (seq, name, args) => ({ seq, type: 'tool/call', time: 1_000 * seq, data: { name, arguments: JSON.stringify(args) } })
const assistantEvent = (seq, text = '完成') => ({ seq, type: 'assistant/message', time: 1_000 * seq, data: { message: { content: [{ type: 'text', text }] } } })
const turnEnd = (seq) => ({ seq, type: 'turn/end', time: 1_000 * seq, data: { reason: { kind: 'completed' } } })

test('derives intent, risk and changed files from one turn of session events', () => {
  const { turns } = insightsFromEvents([
    userEvent(1, '请帮我修复登录页的报错，必须保持现有 API 不变'),
    toolCall(2, 'edit', { file_path: 'src/login.tsx', old_string: 'a\nb', new_string: 'a\nc\nd' }),
    toolCall(3, 'pwsh', { command: 'rm -rf build && npm install' }),
    assistantEvent(4),
    turnEnd(5),
  ], { cwd: 'C:\\work\\app' })

  const insight = turns['1']
  assert.equal(insight.intent.type, 'fix')
  assert.equal(insight.intent.typeLabel, '修复问题')
  assert.equal(insight.intent.goal.startsWith('修复登录页的报错'), true)
  assert.equal(insight.intent.constraints.length, 1)
  assert.match(insight.intent.constraints[0], /必须保持现有 API 不变/)

  assert.equal(insight.files.length, 1)
  assert.equal(insight.files[0].displayPath, 'src/login.tsx')
  assert.equal(insight.files[0].op, 'modify')
  assert.equal(insight.files[0].additions, 3)
  assert.equal(insight.files[0].deletions, 2)

  assert.equal(insight.risk.level, 'critical')
  assert.equal(insight.risk.score, 100)
  assert.equal(insight.risk.reasons.some(reason => reason.label === '破坏性删除或格式化'), true)
  assert.equal(insight.stats.toolCount, 2)
  assert.equal(insight.stats.fileCount, 1)
})

test('treats a turn without tools as low risk and keeps the goal short', () => {
  const { turns } = insightsFromEvents([
    userEvent(1, '解释一下这个仓库的分支模型'),
    assistantEvent(2, '它使用 DAG…'),
    turnEnd(3),
  ])

  const insight = turns['1']
  assert.equal(insight.risk.level, 'low')
  assert.equal(insight.risk.summary, '本轮没有调用工具')
  assert.equal(insight.files.length, 0)
  assert.equal(insight.intent.type, 'analyze')
})

test('parses apply_patch headers into per-file additions and deletions', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/settings.ts',
    '@@',
    '-old line',
    '+new line',
    '+another line',
    '*** Add File: src/new-panel.ts',
    '+export const panel = 1',
    '*** Delete File: src/old-panel.ts',
    '*** End Patch',
  ].join('\n')
  const files = changedFiles([
    { name: 'apply_patch', arguments: JSON.stringify({ patch }) },
  ])
  const byPath = new Map(files.map(file => [file.displayPath, file]))
  assert.equal(byPath.get('src/settings.ts').op, 'modify')
  assert.deepEqual([byPath.get('src/settings.ts').additions, byPath.get('src/settings.ts').deletions], [2, 1])
  assert.equal(byPath.get('src/new-panel.ts').op, 'write')
  assert.equal(byPath.get('src/new-panel.ts').additions, 1)
  assert.equal(byPath.get('src/old-panel.ts').op, 'delete')
})

test('flags writes outside the workspace and raises the score', () => {
  const files = changedFiles([
    { name: 'write', arguments: JSON.stringify({ file_path: 'C:\\other\\secrets.txt', content: 'x' }) },
  ], 'C:\\work\\app')
  assert.equal(files.length, 1)
  assert.equal(files[0].outside, true)

  const risk = assessRisk([
    { name: 'write', arguments: JSON.stringify({ file_path: 'C:\\other\\secrets.txt', content: 'x' }) },
  ], { cwd: 'C:\\work\\app', files })
  assert.equal(risk.reasons.some(reason => reason.label === '工作区外写入'), true)
  assert.ok(risk.score >= 27)
})

test('ignores harness-injected user rows so only real turns get a panel', () => {
  const { turns, byIndex } = insightsFromEvents([
    { seq: 1, type: 'user/message', time: 1000, data: { content: [{ type: 'text', text: '<system-reminder><available_skills>…' }], source: { kind: 'skill-catalog' } } },
    { seq: 2, type: 'user/message', time: 2000, data: { content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }] } },
    userEvent(3, '真正的第一轮'),
    assistantEvent(4),
    turnEnd(5),
  ])
  assert.deepEqual(Object.keys(turns), ['3'])
  assert.equal(byIndex.length, 1)
  assert.equal(byIndex[0].intent.goal, '真正的第一轮')
})

test('does not let a clock snapshot split the real turn', () => {
  const { turns } = insightsFromEvents([
    userEvent(1, '请实现节点洞察'),
    { seq: 2, type: 'user/message', time: 2000, data: { source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1: 2026-11-01T20:14:57+08:00[Asia/Shanghai]' }] } },
    { seq: 3, type: 'user/message', time: 3000, data: { source: { kind: 'tool-jobs' }, content: [{ type: 'text', text: 'background job pwsh-abc finished (exit code: 0)' }] } },
    toolCall(4, 'write', { file_path: 'src/node.ts', content: 'a\nb' }),
    assistantEvent(5),
  ])
  assert.deepEqual(Object.keys(turns), ['1'])
  assert.equal(turns['1'].stats.toolCount, 1)
  assert.equal(turns['1'].files[0].displayPath, 'src/node.ts')
})

test('falls back to stored messages when the session log is unavailable', () => {
  const { turns } = insightsFromMessages([
    { kind: 'user', text: '部署一下这个服务', sourceSeq: 10 },
    { kind: 'assistant', text: '好的', sourceSeq: 11, process: [{ name: 'pwsh', status: 'done' }, { name: 'pwsh', status: 'done' }] },
  ])
  const insight = turns['10']
  assert.equal(insight.intent.type, 'ops')
  assert.equal(insight.stats.toolCount, 2)
  assert.equal(insight.files.length, 0)
  assert.equal(insight.risk.level, 'medium')
})

test('classifies a direct question as analysis rather than a build request', () => {
  const intent = inferIntent('如何把这段代码拆成两个模块？')
  assert.equal(intent.type, 'analyze')
  assert.equal(intent.goal, '如何把这段代码拆成两个模块')
})

test('merges duplicate paths and counts lines only once', () => {
  const files = changedFiles([
    { name: 'edit', arguments: JSON.stringify({ file_path: 'a.ts', old_string: 'x', new_string: 'x\ny' }) },
    { name: 'edit', arguments: JSON.stringify({ file_path: 'a.ts', old_string: 'y', new_string: 'y\nz' }) },
  ])
  assert.equal(files.length, 1)
  assert.equal(files[0].additions, 4)
  assert.equal(files[0].deletions, 2)
})
