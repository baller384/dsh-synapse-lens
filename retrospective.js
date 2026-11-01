// Single-session retrospective.
//
// The conversation map already answers "what happened". This module answers a
// different question: given the goal the session started with, which actions
// moved it forward, which were wasted effort, and what did the session finally
// produce? The result is a review aid, not a performance score: every number is
// derived from observable session facts (turns, tool calls, file writes, risk)
// and is labelled as a heuristic.
//
// Input is a set of Synapse threads with their `insight` payloads attached.
// Output is a tree-scoped retrospective for the thread the user is looking at.

const CORRECTION_RE = /(不对|不是这样|错了|重新|重来|改成|换成|回退|撤销|别这样|不要这样|方向不对|换个思路)/
const REFINEMENT_RE = /(最终|目标是|我要的是|其实我|真正要|归根到底)/
const HARNESS_NOTICE_RE = /^(?:Time sampled while preparing turn |background job [\w-]+ \()/
const MAX_TEXT = 420

/**
 * Build the retrospective for the tree that contains `activeThreadId`.
 *
 * @param threads - Synapse threads; each may carry an `insight` payload from
 *   `insightsFromEvents` / `insightsFromMessages`.
 * @param activeThreadId - thread the user is currently reading; defaults to the
 *   most recently updated root.
 * @param workspaceId - optional id copied into the response.
 */
export function buildRetrospective({ threads, activeThreadId = null, workspaceId = null, deletedCardIds = [] } = {}) {
  const list = Array.isArray(threads) ? threads.filter(thread => thread?.id) : []
  if (list.length === 0) return emptyRetrospective(workspaceId)

  const byId = new Map(list.map(thread => [thread.id, thread]))
  const scope = scopeFor(list, byId, activeThreadId)
  const cardsByThread = new Map()
  const allCards = []
  for (const thread of scope) {
    const cards = cardsForThread(thread)
    cardsByThread.set(thread.id, cards)
    allCards.push(...cards)
  }
  linkCards(scope, byId, cardsByThread)
  if (allCards.length === 0) return emptyRetrospective(workspaceId, scope)

  const cardById = new Map(allCards.map(card => [card.id, card]))
  assignLayers(allCards, cardById)
  assignNumbers(allCards)

  const deleted = new Set((Array.isArray(deletedCardIds) ? deletedCardIds : []).filter(id => typeof id === 'string'))
  const hidden = hiddenCardSet(allCards, deleted)
  const visible = allCards.filter(card => !hidden.has(card.id))
  const rejectedCards = allCards.filter(card => deleted.has(card.id))
  const rejected = rejectedCards
    .filter(card => card.parentId === null || !deleted.has(card.parentId))
    .map(card => ({
      rootCardId: card.id,
      number: card.number,
      question: preview(card.question, 120),
      count: [...hidden].filter(id => {
        const item = cardById.get(id)
        return item !== undefined && (item.id === card.id || isDescendant(item, card.id, cardById))
      }).length,
    }))
  const rejectedCount = hidden.size

  if (visible.length === 0) {
    return finalizeRetrospective({
      ...emptyRetrospective(workspaceId, scope),
      rejected,
      rejectedCount,
      narrative: rejectedCount > 0
        ? `本次会话的可见卡片已全部忽略或切除；${rejectedCount} 个负面行动被剔除，路径无法继续复盘。`
        : '这次会话还没有可复盘的可见行动。',
    })
  }

  const childIds = new Set(visible.map(card => card.parentId).filter(Boolean))
  const leaves = visible.filter(card => !childIds.has(card.id))
  const activeCards = activeThreadId === null ? undefined : (cardsByThread.get(activeThreadId) ?? []).filter(card => !hidden.has(card.id))
  const leaf = activeCards?.at(-1) ?? latest(leaves) ?? latest(visible)
  const path = walkWithLookup(leaf, cardById).filter(card => !hidden.has(card.id))
  const mainIds = new Set(path.map(card => card.id))
  const orderById = new Map(path.map((card, index) => [card.id, index + 1]))

  const impactById = new Map()
  for (const card of visible) {
    const siblings = cardsByThread.get(card.threadId) ?? []
    const next = siblings[card.turnIndex + 1] ?? null
    impactById.set(card.id, scoreTurn(card, next, {
      isMain: mainIds.has(card.id),
      isStart: card.id === path[0]?.id,
      isFinal: card.id === leaf.id,
    }))
  }

  const goal = inferGoal(path)
  const steps = visible.map(card => ({
    cardId: card.id,
    number: card.number,
    threadId: card.threadId,
    seq: card.seq,
    layer: card.layer,
    question: preview(card.question, 180),
    isMain: mainIds.has(card.id),
    order: orderById.get(card.id) ?? null,
    at: card.at ?? null,
    impact: impactById.get(card.id),
  }))
  const mainPath = path.map((card, index) => ({
    cardId: card.id,
    number: card.number,
    threadId: card.threadId,
    seq: card.seq,
    step: index + 1,
    layer: card.layer,
    question: preview(card.question, 220),
    at: card.at ?? null,
    impact: impactById.get(card.id),
  }))
  const branches = sideBranches(visible, mainIds, cardById)
  const phases = buildPhases(path, branches)
  const finalFiles = uniqueFiles(path.flatMap(card => card.insight?.files ?? []))
  const finalOutput = {
    cardId: leaf.id,
    number: leaf.number,
    threadId: leaf.threadId,
    at: leaf.at ?? null,
    text: preview(leaf.answer || leaf.insight?.intent?.goal || leaf.question, 600),
    files: finalFiles.slice(0, 20),
    failed: leaf.insight?.stats?.failed === true || leaf.error !== null,
  }
  const retro = {
    workspaceId,
    rootThreadId: scope[0]?.id ?? null,
    activeThreadId,
    generatedAt: new Date().toISOString(),
    goal,
    start: {
      cardId: path[0]?.id ?? null,
      number: path[0]?.number ?? null,
      threadId: path[0]?.threadId ?? null,
      question: preview(path[0]?.question ?? '', 220),
      at: path[0]?.at ?? null,
    },
    steps,
    mainPath,
    branches,
    phases,
    rejected,
    rejectedCount,
    narrative: '',
    finalOutput,
    stats: {},
    verdict: { tone: 'neutral', text: '' },
    tips: [],
    layers: [],
    promptReview: null,
    model: { used: false },
  }
  retro.narrative = buildNarrative(retro)
  return finalizeRetrospective(retro)
}

/** Stable card number: chronological across the tree, unaffected by deletions. */
function assignNumbers(cards) {
  const ordered = [...cards].sort((a, b) => timeOf(a) - timeOf(b) || (a.seq ?? 0) - (b.seq ?? 0) || a.id.localeCompare(b.id))
  ordered.forEach((card, index) => { card.number = index + 1 })
}

function hiddenCardSet(cards, deleted) {
  const hidden = new Set(deleted)
  let changed = true
  while (changed) {
    changed = false
    for (const card of cards) {
      if (card.parentId !== null && hidden.has(card.parentId) && !hidden.has(card.id)) {
        hidden.add(card.id)
        changed = true
      }
    }
  }
  return hidden
}

function isDescendant(card, ancestorId, cardById) {
  let current = card
  const seen = new Set()
  while (current.parentId !== null && !seen.has(current.id)) {
    seen.add(current.id)
    if (current.parentId === ancestorId) return true
    current = cardById.get(current.parentId)
    if (current === undefined) return false
  }
  return false
}

function sideBranches(cards, mainIds, cardById) {
  const children = new Map()
  for (const card of cards) {
    if (card.parentId === null || !cardById.has(card.parentId)) continue
    const list = children.get(card.parentId) ?? []
    list.push(card.id)
    children.set(card.parentId, list)
  }
  const roots = cards.filter(card => !mainIds.has(card.id)
    && (card.parentId === null || mainIds.has(card.parentId)))
  return roots.map(root => {
    const ids = []
    const seen = new Set()
    const stack = [root.id]
    while (stack.length > 0) {
      const id = stack.pop()
      if (seen.has(id)) continue
      seen.add(id)
      const card = cardById.get(id)
      if (card === undefined || mainIds.has(id)) continue
      ids.push(id)
      for (const childId of children.get(id) ?? []) {
        if (!mainIds.has(childId)) stack.push(childId)
      }
    }
    const list = ids.map(id => cardById.get(id)).filter(Boolean).sort((a, b) => a.number - b.number)
    const parent = root.parentId === null ? undefined : cardById.get(root.parentId)
    return {
      threadId: root.threadId,
      title: branchTitle(list),
      isFork: parent !== undefined && parent.threadId !== root.threadId,
      parentCardId: root.parentId,
      cardIds: list.map(card => card.id),
      numbers: list.map(card => card.number),
      startNumber: list[0]?.number ?? null,
      endNumber: list.at(-1)?.number ?? null,
      startQuestion: preview(list[0]?.question ?? '', 120),
      endQuestion: preview(list.at(-1)?.question ?? '', 120),
    }
  }).sort((a, b) => (a.startNumber ?? 0) - (b.startNumber ?? 0))
}

function branchTitle(cards) {
  const text = cards.map(card => card.question).join(' ')
  if (/(安装|启动|打开|打不开|报错|崩溃|dsh|可用|修复)/i.test(text)) return '部署与可用性'
  if (/(优化|改进|调整|进一步|第二版|再加|个性化|复盘|层|百分比|打分)/.test(text)) return '个性化优化'
  if (/(评估|性能|调研|分析|对比|测试)/.test(text)) return '调研与评估'
  return preview(cards[0]?.question ?? '', 22) || '分支'
}

function mainPhaseTitle(cards) {
  const text = cards.map(card => card.question).join(' ')
  if (/(优化|改进|调整|进一步|第二版|再加|个性化|复盘|层|百分比|打分)/.test(text)) return '个性化优化'
  if (/(安装|启动|打开|打不开|报错|崩溃|dsh|可用|修复)/i.test(text)) return '部署与可用性'
  return '主路径推进'
}

function buildPhases(path, branches) {
  const phases = []
  if (path[0] !== undefined) {
    phases.push({ kind: 'start', title: '目标建立', numbers: [path[0].number], cardIds: [path[0].id], startNumber: path[0].number, endNumber: path[0].number })
  }
  for (const branch of branches) {
    phases.push({ kind: 'branch', title: branch.title, numbers: branch.numbers, cardIds: branch.cardIds, startNumber: branch.startNumber, endNumber: branch.endNumber })
  }
  const tail = path.slice(1)
  if (tail.length > 0) {
    phases.push({ kind: 'main', title: mainPhaseTitle(tail), numbers: tail.map(card => card.number), cardIds: tail.map(card => card.id), startNumber: tail[0].number, endNumber: tail.at(-1).number })
  }
  return phases.sort((a, b) => (a.startNumber ?? 0) - (b.startNumber ?? 0))
}

function buildNarrative(retro) {
  const path = retro.mainPath ?? []
  const branches = retro.branches ?? []
  const rejected = retro.rejected ?? []
  if (path.length === 0) return '没有可复盘的可见路径。'
  const start = path[0]
  const parts = [`从 #${start.number}「${retro.goal?.text ?? ''}」出发。`]
  if (path.length > 1) parts.push(`主路径 ${path.map(card => `#${card.number}`).join(' → ')}。`)
  if (branches.length === 0) parts.push('没有侧分支。')
  else parts.push(branches.map(branch => `#${branch.startNumber}→#${branch.endNumber} 是「${branch.title}」分支`).join('；') + '。')
  if (rejected.length > 0) {
    parts.push(`用户忽略/切除了 ${retro.rejectedCount} 个负面行动（${rejected.map(item => `#${item.number}`).join('、')}），已从路径剔除并计入延误。`)
  } else {
    parts.push('没有忽略或切除的负面行动。')
  }
  return parts.join('')
}

/** Walk parent links once and stamp each card with its column/layer. */
function assignLayers(cards, byId) {
  const visiting = new Set()
  const depthOf = card => {
    if (card.layer !== undefined) return card.layer
    if (!card.parentId || !byId.has(card.parentId) || visiting.has(card.id)) {
      card.layer = 1
      return 1
    }
    visiting.add(card.id)
    const depth = depthOf(byId.get(card.parentId)) + 1
    visiting.delete(card.id)
    card.layer = depth
    return depth
  }
  for (const card of cards) depthOf(card)
}

/**
 * Recompute everything downstream of impact scores: per-step progress shares,
 * layer totals, branch averages, session efficiency, verdict and tips. Called
 * after the rule pass and again after a model review merges into it.
 */
export function finalizeRetrospective(retro) {
  const steps = Array.isArray(retro.steps) ? retro.steps : []
  const positive = steps.filter(step => Number(step.impact?.score) > 0)
  const negative = steps.filter(step => Number(step.impact?.score) < 0)
  const totalPositive = positive.reduce((sum, step) => sum + Number(step.impact.score), 0)
  const positiveShares = distributePercent(positive.map(step => Number(step.impact.score)), 100)
  positive.forEach((step, index) => { step.impact.progress = positiveShares[index] })
  const negativeAbs = negative.reduce((sum, step) => sum + Math.abs(Number(step.impact.score)), 0)
  // Delay is measured against all meaningful movement, not just the positive
  // side: one abandoned branch cannot consume 70% of a session that also
  // produced four times its work.
  const negativeBase = totalPositive + negativeAbs
  const negativeShares = negative.map(step => negativeBase > 0 ? Math.abs(Number(step.impact.score)) / negativeBase * 100 : 0)
  negative.forEach((step, index) => { step.impact.progress = -Math.max(1, Math.round(negativeShares[index])) })
  for (const step of steps) {
    if (!Number.isFinite(step.impact?.progress)) step.impact.progress = 0
    if (step.impact !== undefined) {
      step.impact.layer = step.layer
      const score = Number(step.impact.score) || 0
      step.impact.tone = score >= 15 ? 'positive' : score <= -15 ? 'negative' : 'neutral'
      step.impact.label = step.impact.tone === 'positive' ? '正向' : step.impact.tone === 'negative' ? '负向' : '停滞'
    }
  }

  const stepsById = new Map(steps.map(step => [step.cardId, step]))
  const layerMap = new Map()
  for (const step of steps) {
    const layer = Number.isInteger(step.layer) ? step.layer : 1
    const entry = layerMap.get(layer) ?? { layer, steps: 0, impact: 0, progress: 0 }
    entry.steps += 1
    entry.impact += Number(step.impact?.score) || 0
    entry.progress += Number(step.impact?.progress) || 0
    layerMap.set(layer, entry)
  }
  retro.layers = [...layerMap.values()].sort((a, b) => a.layer - b.layer).map(entry => ({
    ...entry,
    tone: entry.progress >= 1 ? 'positive' : entry.progress <= -1 ? 'negative' : 'neutral',
  }))

  const branches = Array.isArray(retro.branches) ? retro.branches : []
  retro.branches = branches.map(branch => {
    const cards = (branch.cardIds ?? []).map(id => stepsById.get(id)).filter(Boolean)
    const scores = cards.map(step => Number(step.impact?.score) || 0)
    const score = scores.length === 0 ? 0 : Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length)
    const progress = cards.reduce((sum, step) => sum + (Number(step.impact?.progress) || 0), 0)
    const tone = score >= 15 ? 'positive' : score <= -15 ? 'negative' : 'neutral'
    return {
      threadId: branch.threadId,
      title: branch.title,
      isFork: branch.isFork,
      cardIds: branch.cardIds ?? cards.map(step => step.cardId),
      numbers: branch.numbers ?? cards.map(step => step.number),
      startNumber: branch.startNumber ?? cards[0]?.number ?? null,
      endNumber: branch.endNumber ?? cards.at(-1)?.number ?? null,
      startQuestion: branch.startQuestion ?? '',
      endQuestion: branch.endQuestion ?? '',
      isMain: cards.some(step => step.isMain),
      score,
      progress,
      tone,
      label: tone === 'positive' ? '正向' : tone === 'negative' ? '负向' : '停滞',
      turnCount: cards.length,
      files: cards.reduce((sum, step) => sum + (Number(step.impact?.files) || 0), 0),
      lastQuestion: preview(cards.at(-1)?.question ?? '', 120),
    }
  }).sort((a, b) => Number(b.isMain) - Number(a.isMain) || b.score - a.score || a.title.localeCompare(b.title))

  const counts = { positive: 0, neutral: 0, negative: 0 }
  for (const step of steps) counts[step.impact?.tone ?? 'neutral'] += 1
  const rejectedCount = Number(retro.rejectedCount) || 0
  // A deletion is a negative judgement: it removes the card from the path and
  // also costs the session some efficiency. Cap the penalty so a large pruned
  // branch cannot wipe out an otherwise complete delivery.
  const rejectedPenalty = Math.min(50, rejectedCount * 8)
  const delayPercent = Math.min(100, negative.reduce((sum, step) => sum + Math.abs(Number(step.impact?.progress) || 0), 0) + rejectedPenalty)
  const first = retro.mainPath?.[0]
  const last = retro.mainPath?.at(-1)
  const durationMs = first && last && timeOf(first) > 0 && timeOf(last) > 0 ? Math.max(0, timeOf(last) - timeOf(first)) : null
  const fileCount = steps.reduce((sum, step) => sum + (Number(step.impact?.files) || 0), 0)
  retro.stats = {
    turns: steps.length,
    mainTurns: retro.mainPath?.length ?? 0,
    positive: counts.positive,
    neutral: counts.neutral,
    negative: counts.negative,
    files: fileCount,
    durationMs,
    progress: positive.length > 0 ? 100 : 0,
    delayPercent,
    effectivePercent: positive.length > 0 ? Math.max(0, 100 - delayPercent) : 0,
    rejected: rejectedCount,
    rejectedPenalty,
  }
  retro.layers.forEach(entry => {
    entry.percent = retro.stats.progress === 0 ? 0 : entry.progress
  })
  retro.verdict = verdictOf(retro.stats)
  retro.tips = tipsFor(retro)
  if (retro.promptReview === null || retro.promptReview === undefined) retro.promptReview = rulePromptReview(retro)
  return retro
}

/**
 * Merge a model review into the rule retrospective. The model's step score is
 * blended 45/55 with the rule score, so neither layer silently wins; percent
 * shares are recomputed afterwards.
 */
export function applyModelReview(retro, review, meta = {}) {
  const stepsById = new Map((retro.steps ?? []).map(step => [step.cardId, step]))
  for (const item of Array.isArray(review?.steps) ? review.steps : []) {
    const step = stepsById.get(item?.id)
    const modelScore = Number(item?.impact)
    if (step === undefined || !Number.isFinite(modelScore)) continue
    const ruleScore = Number(step.impact?.score) || 0
    step.impact.ruleScore = step.impact.ruleScore ?? ruleScore
    step.impact.llmScore = clamp(Math.round(modelScore), -100, 100)
    step.impact.score = clamp(Math.round(ruleScore * 0.45 + step.impact.llmScore * 0.55), -100, 100)
    if (typeof item.reason === 'string' && item.reason.trim() !== '') {
      step.impact.reasons = [{ text: preview(item.reason, 60), weight: 0 }, ...(step.impact.reasons ?? [])].slice(0, 4)
    }
  }
  if (typeof review?.goal === 'string' && review.goal.trim() !== '') {
    retro.goal.ruleText ??= retro.goal.text
    retro.goal.text = preview(review.goal, 80)
    retro.goal.modelCondensed = true
  }
  if (typeof review?.narrative === 'string' && review.narrative.trim() !== '') {
    retro.narrative = preview(review.narrative, 200)
  }
  retro.promptReview = normalizePromptReview(review?.prompt, retro)
  retro.model = { used: true, ...meta }
  return finalizeRetrospective(retro)
}

function normalizePromptReview(prompt, retro) {
  const fallback = rulePromptReview(retro)
  if (prompt === null || typeof prompt !== 'object') return fallback
  const issues = Array.isArray(prompt.issues) ? prompt.issues.filter(item => typeof item === 'string' && item.trim() !== '').slice(0, 3) : []
  const next = Array.isArray(prompt.next) ? prompt.next.filter(item => typeof item === 'string' && item.trim() !== '').slice(0, 3) : []
  const rewrite = typeof prompt.rewrite === 'string' && prompt.rewrite.trim() !== '' ? preview(prompt.rewrite, 500) : fallback.rewrite
  return {
    source: 'model',
    verdict: typeof prompt.verdict === 'string' && prompt.verdict.trim() !== '' ? preview(prompt.verdict, 90) : fallback.verdict,
    issues: issues.length > 0 ? issues : fallback.issues,
    rewrite,
    next: next.length > 0 ? next : fallback.next,
  }
}

function rulePromptReview(retro) {
  const stats = retro.stats ?? {}
  const goal = retro.goal ?? {}
  const steps = retro.steps ?? []
  const corrections = Number(goal.corrections) || 0
  const firstQuestion = retro.start?.question ?? ''
  const startNumber = retro.start?.number ?? 1
  const issues = []
  if (corrections > 0) issues.push(`中途修正了 ${corrections} 次，首轮 #${startNumber} 的验收条件没有把“什么算完成”说清楚。`)
  if (stats.neutral > stats.positive) issues.push('超过一半步骤没有形成文件产出，探索和铺垫偏多。')
  if (/(然后|再|顺便|同时)/.test(firstQuestion) && firstQuestion.length > 80) issues.push(`首轮 #${startNumber} 同时装了多个目标，模型只能边做边猜优先级。`)
  if (!/(必须|不要|只能|仅|至少|验收|测试)/.test(firstQuestion)) issues.push(`首轮 #${startNumber} 没有给出约束或验收方式，后面只能靠来回修正补齐。`)
  const constraints = Array.isArray(goal.constraints) && goal.constraints.length > 0
    ? goal.constraints.join('；')
    : '只改与目标直接相关的文件，不动无关代码'
  const rewrite = `目标：${goal.text ?? '完成当前任务'}\n约束：${constraints}\n验收：给出可执行的验证方式（测试/构建/运行结果），并说明改了哪些文件。\n先复述目标与计划，确认后再执行；每轮结束汇报「已完成 / 未完成 / 下一步」。`
  const next = [
    '首轮先写一句“完成时我能看到什么”，再列约束。',
    '把大目标拆成一次能验证的小结果，少用“顺便/然后”。',
    '要求模型先复述目标和计划，再动手，减少方向漂移。',
  ]
  return {
    source: 'rules',
    verdict: corrections > 0
      ? `这次会话用了 ${stats.turns ?? 0} 步，其中 ${corrections} 次是方向修正；成本主要花在把 #${startNumber} 的目标说清楚。`
      : `这次会话用 ${stats.turns ?? 0} 步收束；如果首轮 #${startNumber} 补上验收条件，轮次还能更少。`,
    issues: issues.length > 0 ? issues.slice(0, 3) : ['路径没有明显绕路，首轮可以把验收条件写得更具体。'],
    rewrite,
    next,
  }
}

// ---------------------------------------------------------------------------
// Tree shaping
// ---------------------------------------------------------------------------

function scopeFor(threads, byId, activeThreadId) {
  let active = activeThreadId === null ? undefined : byId.get(activeThreadId)
  if (active === undefined) active = latestRoot(threads)
  if (active === undefined) return threads
  let root = active
  const seen = new Set()
  while (root?.parentId && byId.has(root.parentId) && !seen.has(root.id)) {
    seen.add(root.id)
    root = byId.get(root.parentId)
  }
  const ordered = []
  const queue = [root.id]
  const visited = new Set()
  const childrenByParent = new Map()
  for (const thread of threads) {
    if (thread.parentId === null || !byId.has(thread.parentId)) continue
    const children = childrenByParent.get(thread.parentId) ?? []
    children.push(thread.id)
    childrenByParent.set(thread.parentId, children)
  }
  while (queue.length > 0) {
    const id = queue.shift()
    if (visited.has(id)) continue
    visited.add(id)
    const thread = byId.get(id)
    if (thread === undefined) continue
    ordered.push(thread)
    for (const childId of childrenByParent.get(id) ?? []) queue.push(childId)
  }
  return ordered.length > 0 ? ordered : threads
}

function latestRoot(threads) {
  const roots = threads.filter(thread => thread.parentId === null || !threads.some(item => item.id === thread.parentId))
  return latest(roots) ?? threads[0]
}

function cardsForThread(thread) {
  const messages = Array.isArray(thread.messages) ? thread.messages : []
  const insight = thread.insight ?? null
  const cards = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message?.kind !== 'user') continue
    if (typeof message.text === 'string' && HARNESS_NOTICE_RE.test(message.text.trimStart())) continue
    const replies = []
    for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
      if (messages[cursor].kind === 'user') break
      replies.push(messages[cursor])
    }
    const answer = replies.filter(reply => reply.kind === 'assistant').at(-1) ?? null
    const error = replies.filter(reply => reply.kind === 'error').at(-1) ?? null
    const seq = Number.isSafeInteger(message.sourceSeq) ? message.sourceSeq : null
    const turnIndex = cards.length
    const turn = seq === null ? insight?.byIndex?.[turnIndex] : insight?.turns?.[String(seq)]
    cards.push({
      id: `${thread.id}:turn:${seq ?? index}`,
      threadId: thread.id,
      seq,
      turnIndex,
      question: typeof message.text === 'string' ? message.text : '',
      at: message.at ?? null,
      answer: typeof answer?.text === 'string' ? answer.text : '',
      error: typeof error?.text === 'string' ? error.text : null,
      insight: turn ?? null,
    })
  }
  return cards
}

function linkCards(scope, byId, cardsByThread) {
  for (const thread of scope) {
    const cards = cardsByThread.get(thread.id) ?? []
    for (let index = 0; index < cards.length; index += 1) {
      const card = cards[index]
      if (index > 0) {
        card.parentId = cards[index - 1].id
        continue
      }
      const parentThread = thread.parentId === null ? undefined : byId.get(thread.parentId)
      const parentCards = parentThread === undefined ? [] : cardsByThread.get(parentThread.id) ?? []
      const seed = Number.isSafeInteger(thread.sourceSeedLength) ? thread.sourceSeedLength : null
      const inherited = seed === null
        ? undefined
        : parentCards.filter(candidate => Number.isInteger(candidate.seq) && candidate.seq < seed).at(-1)
      card.parentId = inherited?.id ?? parentCards.at(-1)?.id ?? null
    }
  }
}

function walkWithLookup(start, lookup) {
  const path = []
  const seen = new Set()
  let card = start
  while (card !== null && card !== undefined && !seen.has(card.id)) {
    seen.add(card.id)
    path.push(card)
    card = card.parentId === null ? null : lookup.get(card.parentId) ?? null
  }
  return path.reverse()
}

function latest(cards) {
  return [...cards].sort((a, b) => timeOf(b) - timeOf(a))[0] ?? null
}

function timeOf(card) {
  const value = card?.at === null || card?.at === undefined ? NaN : new Date(card.at).getTime()
  return Number.isFinite(value) ? value : 0
}

// ---------------------------------------------------------------------------
// Impact
// ---------------------------------------------------------------------------

function scoreTurn(card, next, context) {
  const insight = card.insight
  const files = Array.isArray(insight?.files) ? insight.files : []
  const risk = insight?.risk ?? null
  const failed = insight?.stats?.failed === true || card.error !== null
  const toolCount = Number.isFinite(insight?.stats?.toolCount) ? insight.stats.toolCount : 0
  let score = 0
  const reasons = []

  if (files.length > 0) {
    const weight = 25 + Math.min(10, (files.length - 1) * 5)
    score += weight
    reasons.push({ text: `推进了 ${files.length} 个文件`, weight })
  }
  if (failed) {
    score -= 35
    reasons.push({ text: '本轮没有完成', weight: -35 })
  }
  // A risky-but-productive turn is still progress: the risk is called out in
  // the reasons, but it should not cancel the work that moved the goal.
  if (risk?.level === 'critical') {
    score -= 15
    reasons.push({ text: '出现极高风险动作', weight: -15 })
  } else if (risk?.level === 'high') {
    score -= 6
    reasons.push({ text: '出现高风险动作', weight: -6 })
  }
  if (files.length === 0 && toolCount === 0) {
    reasons.push({ text: '只有讨论，没有实际动作', weight: 0 })
  } else if (files.length === 0 && toolCount > 0 && !failed) {
    score += 4
    reasons.push({ text: '只读探索，为后续铺垫', weight: 4 })
  }
  if (next !== null && typeof next.question === 'string' && CORRECTION_RE.test(next.question)) {
    score -= 20
    reasons.push({ text: '下一轮被修正或回退', weight: -20 })
  }
  if (context.isStart) {
    score += 5
    reasons.push({ text: '确立了本次会话的目标', weight: 5 })
  }
  if (context.isFinal && !failed) {
    score += 12
    reasons.push({ text: '收束并给出最终产出', weight: 12 })
  }

  score = clamp(Math.round(score), -100, 100)
  const tone = score >= 15 ? 'positive' : score <= -15 ? 'negative' : 'neutral'
  return {
    score,
    tone,
    label: tone === 'positive' ? '正向' : tone === 'negative' ? '负向' : '停滞',
    reasons: reasons.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 4),
    files: files.length,
    risk: risk?.level ?? 'unknown',
    failed,
  }
}

function summarize(allCards, path, impactById) {
  const counts = { positive: 0, neutral: 0, negative: 0 }
  for (const card of allCards) {
    const tone = impactById.get(card.id)?.tone ?? 'neutral'
    counts[tone] += 1
  }
  const files = uniqueFiles(allCards.flatMap(card => card.insight?.files ?? []))
  const first = path[0] ?? allCards[0]
  const last = path.at(-1) ?? allCards.at(-1)
  const durationMs = first && last && timeOf(first) > 0 && timeOf(last) > 0 ? Math.max(0, timeOf(last) - timeOf(first)) : null
  return {
    turns: allCards.length,
    mainTurns: path.length,
    positive: counts.positive,
    neutral: counts.neutral,
    negative: counts.negative,
    files: files.length,
    durationMs,
  }
}

function branchSummary(thread, cards, mainIds, impactById) {
  const scores = cards.map(card => impactById.get(card.id)?.score ?? 0)
  const score = scores.length === 0 ? 0 : Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length)
  const tone = score >= 15 ? 'positive' : score <= -15 ? 'negative' : 'neutral'
  const files = uniqueFiles(cards.flatMap(card => card.insight?.files ?? []))
  return {
    threadId: thread.id,
    title: thread.title ?? thread.dshSessionTitle ?? '未命名会话',
    isMain: cards.some(card => mainIds.has(card.id)),
    isFork: thread.parentId !== null,
    score,
    tone,
    label: tone === 'positive' ? '正向' : tone === 'negative' ? '负向' : '停滞',
    turnCount: cards.length,
    files: files.length,
    lastQuestion: preview(cards.at(-1)?.question ?? '', 120),
  }
}

// ---------------------------------------------------------------------------
// Goal / verdict
// ---------------------------------------------------------------------------

function inferGoal(path) {
  const first = path[0]
  const firstIntent = first?.insight?.intent ?? null
  let text = firstIntent?.goal ?? (first?.question ? preview(first.question, 120) : '未能识别出明确目标')
  let typeLabel = firstIntent?.typeLabel ?? '对话讨论'
  const refinements = path.slice(1).filter(card => typeof card.question === 'string' && REFINEMENT_RE.test(card.question))
  if (refinements.length > 0) {
    const last = refinements.at(-1)
    text = last.insight?.intent?.goal ?? preview(last.question, 120)
    typeLabel = last.insight?.intent?.typeLabel ?? typeLabel
  }
  const corrections = path.slice(1).filter(card => typeof card.question === 'string' && CORRECTION_RE.test(card.question)).length
  return {
    text,
    typeLabel,
    confidence: firstIntent?.confidence ?? 'low',
    constraints: Array.isArray(firstIntent?.constraints) ? firstIntent.constraints.slice(0, 4) : [],
    corrections,
    note: corrections > 0 ? `中途修正 ${corrections} 次` : '沿初始目标推进',
    basis: '以第一条真实用户消息为主，结合后续“最终/目标是”这类表述',
  }
}

function verdictOf(stats) {
  if (stats.turns === 0) {
    return stats.rejected > 0
      ? { tone: 'negative', text: `可见路径已被忽略/切除；${stats.rejected} 个负面行动会计入延误。` }
      : { tone: 'neutral', text: '这次会话还没有可复盘的行动。' }
  }
  if (stats.rejected > 0) {
    return { tone: 'negative', text: `用户忽略/切除了 ${stats.rejected} 个负面行动，路径已重算；先确认是否也把必要的前置步骤一并剔除了。` }
  }
  if (stats.negative >= Math.max(1, Math.ceil(stats.turns * 0.3))) return { tone: 'negative', text: '推进中有明显反复：负向步骤占比偏高，建议回看被修正的节点。' }
  if (stats.positive >= Math.ceil(stats.turns * 0.5)) return { tone: 'positive', text: '主路径整体在向目标推进，产出集中在少数关键步骤。' }
  return { tone: 'neutral', text: '行动以探索和铺垫为主，真正的产出步骤不多。' }
}

function tipsFor(retro) {
  const stats = retro.stats ?? {}
  const goal = retro.goal ?? {}
  const tips = []
  if (stats.negative > 0) tips.push(`有 ${stats.negative} 个负向步骤，优先回看这些节点的触发原因，比看成功步骤更有价值。`)
  if (stats.neutral > stats.positive) tips.push('超过一半的步骤没有形成文件产出，可能探索偏多；下次可以先把验收条件写成一条可检查的结果。')
  const risky = (retro.steps ?? []).filter(step => step.impact?.risk === 'critical').length
  if (risky > 0) tips.push(`有 ${risky} 个步骤包含极高风险动作，考虑把验证拆成更小的、可回退的实验。`)
  if ((retro.rejectedCount ?? 0) > 0) tips.push(`已忽略/切除 ${retro.rejectedCount} 个负面行动；确认未来对话不再重复这类提问路径。`)
  if ((goal.corrections ?? 0) > 1) tips.push(`目标在中途被修正 ${goal.corrections} 次；可以在开工前先写一句“完成时我能看到什么”，减少方向漂移。`)
  if (tips.length === 0) tips.push('把最终目的写成一句可验收的话，再按步骤标注产出，下次复盘会更快。')
  return tips.slice(0, 3)
}

function negativesLengthShare(count) {
  return count > 0 ? 100 / count : 0
}

/** Largest-remainder split so the positive shares add up to exactly 100. */
function distributePercent(weights, total) {
  const sum = weights.reduce((acc, value) => acc + Math.max(0, value), 0)
  if (sum <= 0 || weights.length === 0) return weights.map(() => 0)
  const raw = weights.map(value => Math.max(0, value) / sum * total)
  const shares = raw.map(Math.floor)
  let remainder = total - shares.reduce((acc, value) => acc + value, 0)
  const order = raw.map((value, index) => ({ index, fraction: value - shares[index] })).sort((a, b) => b.fraction - a.fraction)
  for (let index = 0; remainder > 0; index += 1) {
    shares[order[index % order.length].index] += 1
    remainder -= 1
  }
  return shares
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function uniqueFiles(files) {
  const seen = new Set()
  const result = []
  for (const file of files) {
    const key = String(file?.displayPath ?? file?.path ?? '').toLowerCase()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    result.push(file)
  }
  return result
}

function preview(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function emptyRetrospective(workspaceId, scope = []) {
  return {
    workspaceId,
    rootThreadId: scope[0]?.id ?? null,
    activeThreadId: null,
    generatedAt: new Date().toISOString(),
    goal: { text: '没有可复盘的会话', typeLabel: '对话讨论', confidence: 'low', constraints: [], corrections: 0, note: '', basis: '' },
    start: { cardId: null, threadId: null, question: '', at: null },
    steps: [],
    mainPath: [],
    branches: [],
    layers: [],
    finalOutput: { cardId: null, threadId: null, at: null, text: '', files: [], failed: false },
    stats: { turns: 0, mainTurns: 0, positive: 0, neutral: 0, negative: 0, files: 0, durationMs: null, progress: 0, delayPercent: 0, effectivePercent: 0 },
    verdict: { tone: 'neutral', text: '这次会话还没有可复盘的行动。' },
    tips: [],
    promptReview: null,
    model: { used: false },
  }
}
