// Optional model pass for the single-session retrospective.
//
// The rule engine in retrospective.js is fast, deterministic and always runs.
// This module adds the second layer the product needs: one call to the model
// the user already selected in DSH, which (a) condenses the inferred goal,
// (b) reviews each step's contribution, and (c) coaches the next prompt.
//
// It is deliberately failure-tolerant: a missing provider, an expired login or
// a malformed reply leaves the rule retrospective intact.

const SYSTEM = [
  '你是资深工程交付教练，负责复盘一次编码会话，并训练提问者更高效地与模型协作。',
  '只输出 JSON，不要 markdown、不要解释 JSON 之外的内容。',
  '评分范围 -100 到 100：正数表示推进最终目标，负数表示返工、偏离或延误，0 表示停滞。',
  '评分要看“这一步对最终目标的影响”，不要按代码量或工具次数机械打分。',
  '提问复盘要具体：指出是哪个提问习惯让路径变长，并给出可以直接复制的更好首轮提示词。',
  '更好的提示词应包含：目标、约束、验收方式，以及“先复述计划再执行”的要求。',
  '`rejected` 里的卡片是用户主动删除的负面行动：不要把它们当主路径，明确记为负向，并在 narrative 中指出删除。',
  '所有叙述都要使用卡片编号（#1、#2…），不要只写“第一步/第二步”。',
].join('\n')

const SCHEMA_HINT = `{
  "goal": "不超过 30 个汉字，保留关键约束",
  "narrative": "不超过 140 个汉字，用 #编号 串起主路径和分支",
  "steps": [{"id": "卡片 id，必须原样返回", "impact": -100, "reason": "不超过 28 个汉字"}],
  "prompt": {
    "verdict": "不超过 45 个汉字，评价这次提问的整体效率",
    "issues": ["最多 3 条，具体指出哪个提问习惯导致绕路"],
    "rewrite": "一段更好的首轮提示词，最多 220 字，包含目标/约束/验收/先复述计划",
    "next": ["最多 3 条下次提问原则"]
  }
}`

/**
 * Resolve the provider/model the user is already using. A profile can override
 * it with `config.llm = { provider, model }`; otherwise the default model
 * selection of the running DSH is used.
 */
export function resolveLlmSelection(ctx, config) {
  if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
    return { provider: config.provider, model: config.model }
  }
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (selection?.provider && selection?.model) return selection
  } catch {
    // The service is optional; fall through to provider discovery.
  }
  try {
    const providers = ctx.get('llm')?.listProviders?.() ?? []
    const first = providers.find(provider => Array.isArray(provider?.models) && provider.models.length > 0)
      ?? providers[0]
    const model = Array.isArray(first?.models) ? first.models[0] : first?.defaultModel
    if (typeof first?.id === 'string' && typeof model === 'string') return { provider: first.id, model }
  } catch {
    // No usable route: the caller reports "rules only".
  }
  return null
}

/**
 * One model call. Returns a normalized review:
 * `{ goal, steps: [{ id, impact, reason }], prompt: { verdict, issues, rewrite, next } }`.
 */
export async function reviewWithModel({ ctx, config, retrospective, signal }) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('当前 DSH 没有可用的 llm 服务')
  const selection = resolveLlmSelection(ctx, config)
  if (selection === null) throw new Error('没有找到可用的默认模型')

  // Review is a structured extraction, not a reasoning benchmark: take the
  // cheapest reasoning effort the selected model advertises.
  const call = await llm.prepareCall({ ...selection, maxTokens: 1800 }, signal, (controls, model) => {
    const effort = model?.reasoning?.efforts?.[0]
    return effort === undefined ? controls : { ...controls, reasoningEffort: effort.id }
  })
  const input = buildInput(retrospective)
  const options = {
    ...call.config,
    system: SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
    signal,
  }
  let text = ''
  let finish
  for await (const chunk of call.stream(options)) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk?.type === 'finish') finish = chunk.reason
  }
  if (finish?.kind === 'error') throw new Error(finish.failure?.message ?? '模型调用失败')
  if (finish?.kind === 'aborted') throw new Error('模型复盘超时')
  if (text.trim() === '') throw new Error('模型没有返回内容')
  const parsed = parseJson(text)
  const review = normalizeReview(parsed)
  if (review.steps.length === 0 && review.goal === null) throw new Error('模型返回的复盘结构不可用')
  return { review, meta: { provider: selection.provider, model: selection.model } }
}

function buildInput(retrospective) {
  const steps = (retrospective.steps ?? []).map(step => ({
    id: step.cardId,
    layer: step.layer,
    question: clip(step.question, 140),
    ruleImpact: step.impact?.score ?? 0,
    files: step.impact?.files ?? 0,
    risk: step.impact?.risk ?? 'unknown',
    failed: step.impact?.failed === true,
    main: step.isMain === true,
  }))
  const branches = (retrospective.branches ?? []).map(branch => ({
    title: branch.title,
    numbers: branch.numbers,
    turns: branch.turnCount,
    ruleScore: branch.score,
  }))
  const rejected = (retrospective.rejected ?? []).map(item => ({
    number: item.number,
    question: clip(item.question, 120),
    count: item.count,
  }))
  return [
    '请复盘下面这次会话，并严格按 JSON schema 输出。',
    `JSON schema: ${SCHEMA_HINT}`,
    '',
    `首次提问：${clip(retrospective.start?.question, 300)}`,
    `规则初判目标：${retrospective.goal?.text ?? ''}`,
    `目标约束：${(retrospective.goal?.constraints ?? []).join('；') || '未识别'}`,
    `会话步数：${retrospective.stats?.turns ?? steps.length}；文件改动：${retrospective.stats?.files ?? 0}`,
    `最终产出：${clip(retrospective.finalOutput?.text, 260)}`,
    `规则叙述：${clip(retrospective.narrative, 260)}`,
    '',
    '步骤：',
    JSON.stringify(steps),
    '侧分支：',
    JSON.stringify(branches),
    '已删除的负面卡片：',
    JSON.stringify(rejected),
  ].join('\n')
}

function parseJson(text) {
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型返回不是有效 JSON')
  return JSON.parse(cleaned.slice(start, end + 1))
}

function normalizeReview(value) {
  const goal = typeof value?.goal === 'string' && value.goal.trim() !== '' ? value.goal.trim() : null
  const narrative = typeof value?.narrative === 'string' && value.narrative.trim() !== '' ? value.narrative.trim() : null
  const steps = Array.isArray(value?.steps)
    ? value.steps.flatMap(item => {
      if (typeof item?.id !== 'string' || item.id === '') return []
      const impact = Number(item?.impact)
      if (!Number.isFinite(impact)) return []
      return [{ id: item.id, impact, reason: typeof item.reason === 'string' ? item.reason.trim() : '' }]
    }).slice(0, 80)
    : []
  const prompt = value?.prompt !== null && typeof value?.prompt === 'object'
    ? {
      verdict: typeof value.prompt.verdict === 'string' ? value.prompt.verdict.trim() : '',
      issues: Array.isArray(value.prompt.issues) ? value.prompt.issues.filter(item => typeof item === 'string').slice(0, 3) : [],
      rewrite: typeof value.prompt.rewrite === 'string' ? value.prompt.rewrite.trim() : '',
      next: Array.isArray(value.prompt.next) ? value.prompt.next.filter(item => typeof item === 'string').slice(0, 3) : [],
    }
    : null
  return { goal, narrative, steps, prompt }
}

function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}
