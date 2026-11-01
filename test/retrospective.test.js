import assert from 'node:assert/strict'
import test from 'node:test'
import { applyModelReview, buildRetrospective } from '../retrospective.js'

const at = (minute) => `2026-11-01T10:${String(minute).padStart(2, '0')}:00Z`

function insight({ type = 'build', label = '实现功能', goal = '实现功能', files = 0, risk = 'low', tools = 2, failed = false } = {}) {
  return {
    turns: {},
    byIndex: [],
    intent: { goal, type, typeLabel: label, confidence: 'medium', constraints: [], basis: 'test' },
    risk: { score: risk === 'high' ? 45 : risk === 'critical' ? 80 : 10, level: risk, label: risk === 'high' ? '高' : risk === 'critical' ? '极高' : '低', reasons: [], summary: '' },
    files: Array.from({ length: files }, (_, index) => ({ path: `src/f${index}.ts`, displayPath: `src/f${index}.ts`, op: 'modify', outside: false, additions: 1, deletions: 0 })),
    stats: { toolCount: tools, fileCount: files, failed, durationMs: 1000, tools: [] },
  }
}

function thread(id, messages, extra = {}) {
  return { id, title: id, parentId: null, sourceSeedLength: null, messages, insight: { turns: {}, byIndex: [] }, ...extra }
}

function user(seq, text, time) {
  return { kind: 'user', text, sourceSeq: seq, at: time }
}

function answer(seq, text, time) {
  return { kind: 'assistant', text, sourceSeq: seq, at: time }
}

test('builds a goal, a main path and per-step impact from a linear session', () => {
  const t1 = thread('t1', [
    user(1, '帮我实现登录页，必须保留现有 API', at(0)),
    answer(2, '先梳理登录页结构', at(1)),
    user(3, '再看一下现有状态管理怎么接', at(2)),
    answer(4, '状态管理接在 store 里', at(3)),
    user(5, '把改动收尾并跑通构建', at(4)),
    answer(6, '登录页已完成，构建通过', at(5)),
  ])
  t1.insight.turns = {
    1: insight({ files: 2, risk: 'medium', tools: 4, goal: '实现登录页并保留 API' }),
    3: insight({ files: 0, risk: 'low', tools: 2, goal: '确认状态管理的接法', type: 'analyze', label: '调研分析' }),
    5: insight({ files: 1, risk: 'high', tools: 3, goal: '收尾并跑通构建' }),
  }

  const result = buildRetrospective({ threads: [t1], activeThreadId: 't1' })
  assert.equal(result.goal.text, '实现登录页并保留 API')
  assert.equal(result.mainPath.length, 3)
  assert.deepEqual(result.mainPath.map(step => step.cardId), ['t1:turn:1', 't1:turn:3', 't1:turn:5'])
  assert.equal(result.mainPath[0].impact.tone, 'positive')
  assert.equal(result.mainPath[1].impact.tone, 'neutral')
  assert.equal(result.mainPath[2].impact.tone, 'positive')
  assert.equal(result.finalOutput.text, '登录页已完成，构建通过')
  assert.equal(result.stats.positive, 2)
  assert.equal(result.stats.neutral, 1)
  assert.equal(result.stats.negative, 0)
  assert.equal(result.start.cardId, 't1:turn:1')
})

test('marks the action before a correction as negative or stagnant', () => {
  const t1 = thread('t1', [
    user(1, '先按弹窗实现', at(0)),
    answer(2, '已加弹窗', at(1)),
    user(3, '不对，改成贴卡展开面板', at(2)),
    answer(4, '已改成面板', at(3)),
  ])
  t1.insight.turns = {
    1: insight({ files: 1, risk: 'low', tools: 3, goal: '按弹窗实现' }),
    3: insight({ files: 1, risk: 'low', tools: 3, goal: '改成贴卡展开面板' }),
  }

  const result = buildRetrospective({ threads: [t1], activeThreadId: 't1' })
  const first = result.mainPath[0].impact
  assert.equal(first.reasons.some(reason => reason.text === '下一轮被修正或回退'), true)
  assert.equal(first.tone, 'neutral')
  assert.equal(result.goal.corrections, 1)
  assert.match(result.goal.note, /修正 1 次/)
})

test('scores a failed turn as negative and keeps it in the path', () => {
  const t1 = thread('t1', [user(1, '跑一下构建', at(0)), { kind: 'error', text: '构建失败', sourceSeq: 2, at: at(1) }])
  t1.insight.turns = {
    1: insight({ files: 0, risk: 'medium', tools: 3, failed: true, goal: '跑通构建' }),
  }

  const result = buildRetrospective({ threads: [t1], activeThreadId: 't1' })
  assert.equal(result.mainPath[0].impact.tone, 'negative')
  assert.equal(result.mainPath[0].impact.failed, true)
  assert.equal(result.finalOutput.failed, true)
  assert.equal(result.verdict.tone, 'negative')
})

test('follows a fork from the parent turn and compares side branches', () => {
  const parent = thread('parent', [
    user(1, '建立画布基础', at(0)),
    answer(2, '基础完成', at(1)),
    user(3, '加一个入口', at(2)),
    answer(4, '入口完成', at(3)),
  ])
  parent.insight.turns = {
    1: insight({ files: 2, goal: '建立画布基础' }),
    3: insight({ files: 1, goal: '加一个入口' }),
  }
  const fork = thread('fork', [
    user(5, '改成侧栏入口', at(4)),
    answer(6, '侧栏完成', at(5)),
  ], { parentId: 'parent', sourceSeedLength: 4 })
  fork.insight.turns = { 5: insight({ files: 2, risk: 'high', goal: '改成侧栏入口' }) }
  const side = thread('side', [
    user(7, '顺手试试弹窗版本', at(6)),
    answer(8, '弹窗完成', at(7)),
  ], { parentId: 'parent', sourceSeedLength: 4 })
  side.insight.turns = { 7: insight({ files: 1, goal: '试试弹窗版本' }) }

  const result = buildRetrospective({ threads: [parent, fork, side], activeThreadId: 'fork' })
  assert.deepEqual(result.mainPath.map(step => step.cardId), ['parent:turn:1', 'parent:turn:3', 'fork:turn:5'])
  assert.equal(result.branches.length, 1)
  assert.equal(result.branches[0].threadId, 'side')
  assert.equal(result.branches[0].turnCount, 1)
  assert.deepEqual(result.branches[0].numbers, [4])
  assert.equal(result.stats.mainTurns, 3)
  assert.equal(result.stats.turns, 4)
  assert.equal(result.phases.some(phase => phase.title === '个性化优化' || phase.title === '主路径推进'), true)
  assert.match(result.narrative, /#1/)

})

test('lets an explicit final-goal sentence refine the inferred goal', () => {
  const t1 = thread('t1', [
    user(1, '先随便搭个页面', at(0)),
    answer(2, '页面完成', at(1)),
    user(3, '最终我要的是一个可复盘的节点洞察面板', at(2)),
    answer(4, '面板完成', at(3)),
  ])
  t1.insight.turns = {
    1: insight({ files: 1, goal: '先随便搭个页面' }),
    3: insight({ files: 2, goal: '做一个可复盘的节点洞察面板' }),
  }

  const result = buildRetrospective({ threads: [t1], activeThreadId: 't1' })
  assert.equal(result.goal.text, '做一个可复盘的节点洞察面板')
  assert.equal(result.goal.corrections, 0)
})

test('normalizes positive impacts into a 100% session and per-layer shares', () => {
  const t1 = thread('t1', [
    user(1, '实现登录页', at(0)),
    answer(2, '完成一部分', at(1)),
    user(3, '收尾并跑构建', at(2)),
    answer(4, '完成', at(3)),
  ])
  t1.insight.turns = {
    1: insight({ files: 2, risk: 'medium', tools: 4, goal: '实现登录页' }),
    3: insight({ files: 1, risk: 'low', tools: 3, goal: '收尾并跑构建' }),
  }
  const result = buildRetrospective({ threads: [t1], activeThreadId: 't1' })
  const shares = result.mainPath.map(step => step.impact.progress)
  assert.equal(shares.reduce((sum, value) => sum + value, 0), 100)
  assert.equal(result.stats.progress, 100)
  assert.equal(result.stats.effectivePercent, 100)
  assert.equal(result.layers.length, 2)
  assert.equal(result.layers.reduce((sum, layer) => sum + layer.progress, 0), 100)
  assert.deepEqual(result.mainPath.map(step => step.layer), [1, 2])
})

test('a session with no positive step reports zero progress instead of a fake 100%', () => {
  const t1 = thread('t1', [user(1, '跑构建', at(0)), { kind: 'error', text: '失败', sourceSeq: 2, at: at(1) }])
  t1.insight.turns = { 1: insight({ files: 0, risk: 'medium', tools: 3, failed: true }) }
  const result = buildRetrospective({ threads: [t1], activeThreadId: 't1' })
  assert.equal(result.stats.progress, 0)
  assert.equal(result.stats.effectivePercent, 0)
  assert.equal(result.mainPath[0].impact.progress, -100)
})

test('blends a model review with the rule score and keeps both layers visible', () => {
  const t1 = thread('t1', [user(1, '实现登录页', at(0)), answer(2, '完成', at(1))])
  t1.insight.turns = { 1: insight({ files: 1, goal: '实现登录页' }) }
  const result = buildRetrospective({ threads: [t1], activeThreadId: 't1' })
  const ruleScore = result.mainPath[0].impact.score
  applyModelReview(result, {
    goal: '交付可用的登录页',
    steps: [{ id: 't1:turn:1', impact: -100, reason: '方向偏了' }],
    prompt: { verdict: '首轮缺少验收', issues: ['没有验收条件'], rewrite: '目标 + 验收 + 先复述', next: ['先写验收'] },
  }, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })

  const impact = result.mainPath[0].impact
  assert.equal(impact.ruleScore, ruleScore)
  assert.equal(impact.llmScore, -100)
  assert.equal(impact.score, Math.round(ruleScore * 0.45 - 100 * 0.55))
  assert.equal(impact.tone, 'negative')
  assert.equal(result.goal.text, '交付可用的登录页')
  assert.equal(result.goal.modelCondensed, true)
  assert.equal(result.model.used, true)
  assert.equal(result.promptReview.source, 'model')
  assert.equal(result.promptReview.rewrite, '目标 + 验收 + 先复述')
})

test('a deleted card subtree leaves the path and is charged as a negative penalty', () => {
  const t1 = thread('t1', [
    user(1, '实现登录页', at(0)),
    answer(2, '先做一版', at(1)),
    user(3, '安装好了吗', at(2)),
    answer(4, '好了', at(3)),
    user(5, '打不开 dsh', at(4)),
    answer(6, '修好了', at(5)),
  ])
  t1.insight.turns = {
    1: insight({ files: 2, goal: '实现登录页' }),
    3: insight({ files: 0, tools: 1, goal: '确认安装' }),
    5: insight({ files: 1, goal: '修复启动' }),
  }
  const result = buildRetrospective({ threads: [t1], activeThreadId: 't1', deletedCardIds: ['t1:turn:3'] })
  assert.deepEqual(result.mainPath.map(step => step.number), [1])
  assert.equal(result.steps.length, 1)
  assert.equal(result.rejectedCount, 2)
  assert.equal(result.rejected[0].number, 2)
  assert.equal(result.rejected[0].count, 2)
  assert.equal(result.stats.rejected, 2)
  assert.equal(result.stats.delayPercent, 16)
  assert.equal(result.stats.effectivePercent, 84)
  assert.match(result.narrative, /#2/)
  assert.equal(result.verdict.tone, 'negative')
})

test('returns an empty retrospective instead of throwing when there are no threads', () => {
  const result = buildRetrospective({ threads: [] })
  assert.equal(result.stats.turns, 0)
  assert.deepEqual(result.mainPath, [])
  assert.equal(result.verdict.tone, 'neutral')
})
