// Node-level insight derivation for the Synapse Lens canvas.
//
// This module never calls a model. It reads the DSH session events that were
// already committed and turns one user turn into three explainable facets:
//   * what the turn was trying to achieve (intent),
//   * how risky the actions taken in that turn were,
//   * which files those actions changed.
//
// Everything here is deterministic so the same session log always produces the
// same panel. The canvas labels the result as rule-based instead of pretending
// it is a model judgement.

const MAX_GOAL_CHARS = 46
const MAX_QUESTION_PREVIEW = 420
const MAX_REASON_CHARS = 120
const MAX_FILES = 40
const MAX_CONSTRAINTS = 3

const FIX_RE = /(修复|修好|报错|错误|异常|bug|故障|崩溃|不工作|失败|排查|解决.{0,8}(?:问题|错误))/i
const INTENT_RULES = [
  ['build', /(实现|新增|添加|开发|创建|搭建|编写|做一个|写一个|接入|支持|上线)/i, '实现功能'],
  ['refactor', /(重构|整理|优化|简化|拆分|迁移|清理|解耦)/i, '重构优化'],
  ['test', /(测试|用例|覆盖|验证|复现)/i, '测试验证'],
  ['docs', /(文档|readme|注释|说明|手册)/i, '文档说明'],
  ['analyze', /(分析|调研|评估|研究|阅读|理解|解释|比较|为什么|怎么|如何|区别)/i, '调研分析'],
  ['ops', /(配置|部署|打包|发布|构建|安装|环境|权限)/i, '配置部署'],
  ['design', /(设计|方案|架构|规划|思路|选型)/i, '方案设计'],
  ['review', /(审查|检查|验收|review|评审)/i, '审查验收'],
]
const QUESTION_FORM_RE = /^(?:如何|怎么|怎样|为什么|什么是|是否|能否|可不可以)/

const SHELL_TOOLS = /^(?:pwsh|powershell|bash|sh|zsh|cmd|shell|terminal|run_command|run_shell|exec|execute|execute_command)$/i
const PATCH_TOOLS = /^(?:apply_patch|patch|diff|multi_edit|apply_diff)$/i
const FILE_TOOLS = /^(?:write|write_file|create|create_file|edit|edit_file|str_replace|replace|modify|delete|delete_file|remove|remove_file|notebook_edit|write_notebook)$/i
const NETWORK_TOOLS = /^(?:web_search|web_fetch|browser|fetch|http|request)$/i
const AGENT_TOOLS = /^(?:subagent|agent|task|delegate|subagent_fork)$/i

const RISK_LEVELS = [
  { level: 'critical', label: '极高', at: 60 },
  { level: 'high', label: '高', at: 35 },
  { level: 'medium', label: '中', at: 15 },
  { level: 'low', label: '低', at: 0 },
]

const SHELL_RULES = [
  {
    weight: 55,
    label: '破坏性删除或格式化',
    re: /(?:\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+|Remove-Item\b[^\n]*-Recurse|rmdir\s+\/s|\bdel\s+\/[sqf]|\brd\s+\/s|git\s+clean\s+-[a-z]*f|git\s+reset\s+--hard|shutdown\b|Stop-Computer|DROP\s+(?:TABLE|DATABASE)|format\s+[a-z]:)/i,
  },
  {
    weight: 45,
    label: '远程脚本直接执行',
    re: /(?:curl[^\n|]*\|\s*(?:ba|z|da)?sh|wget[^\n|]*\|\s*(?:ba)?sh|Invoke-Expression|\biex\s*\(|iwr[^\n|]*\|\s*iex)/i,
  },
  { weight: 35, label: '强制推送或改写远端历史', re: /git\s+push[^\n]*(?:--force|-f\b)/i },
  { weight: 25, label: '提权执行', re: /\bsudo\s|Start-Process[^\n]*-Verb\s+RunAs/i },
  { weight: 20, label: '安装依赖或改写运行环境', re: /\b(?:npm|pnpm|yarn|pip|pip3|uv|cargo|go|winget|choco)\s+(?:install|add|i)\b/i },
  { weight: 15, label: '改写 Git 历史', re: /\bgit\s+(?:commit|merge|rebase|cherry-pick|tag)\b/i },
  { weight: 12, label: '通过命令写入文件', re: /(?:Set-Content|Add-Content|Out-File|New-Item\b[^\n]*-ItemType|\btee\b|>\s*[^\s|&;<>]+)/i },
]

/**
 * Turn a session event log into per-turn insights keyed by the user message's
 * sequence number. `events` may be the tail of a forked session: only turns
 * present in it are reported.
 */
export function insightsFromEvents(events, options = {}) {
  const cwd = typeof options.cwd === 'string' ? options.cwd : ''
  const turns = []
  let current = null
  // The harness writes scoped snapshots (runtime context, clock, background-job
  // notices) through the same user/message channel. They are not turns: if one
  // split the log, the tool calls of the real request would be attributed to a
  // clock note and the user's own card would look idle.
  const isNotice = text => isHarnessNoticeText(text)
  const flush = () => {
    if (current !== null) turns.push(current)
    current = null
  }

  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'user/message') {
      if (isInjectedUserSource(event.data?.source)) continue
      const text = contentText(event.data?.content)
      if (text.trim() === '' || isNotice(text)) continue
      flush()
      current = {
        seq: Number.isSafeInteger(event.seq) ? event.seq : null,
        question: text,
        tools: [],
        startedAt: event.time,
        endedAt: event.time,
        failed: false,
      }
      continue
    }
    if (current === null) continue
    if (event?.type === 'tool/call') {
      current.tools.push({
        name: typeof event.data?.name === 'string' ? event.data.name : '',
        arguments: event.data?.arguments ?? null,
      })
      if (typeof event.time === 'number') current.endedAt = event.time
      continue
    }
    if (event?.type === 'assistant/message') {
      if (typeof event.time === 'number') current.endedAt = event.time
      continue
    }
    if (event?.type === 'turn/end') {
      const reason = event.data?.reason
      if (reason?.kind === 'error' || reason?.kind === 'cancelled' || reason?.kind === 'canceled' || reason?.kind === 'aborted') current.failed = true
      if (typeof event.time === 'number') current.endedAt = event.time
    }
  }
  flush()

  return finishTurns(turns, cwd)
}

/**
 * Fallback for canvas-only notes and for sessions whose log is unavailable:
 * derive what is possible from the stored messages. Stored v5 process records
 * carry names and statuses only, so file paths are usually absent here.
 */
export function insightsFromMessages(messages, options = {}) {
  const cwd = typeof options.cwd === 'string' ? options.cwd : ''
  const turns = []
  let current = null
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.kind === 'user') {
      if (isHarnessNoticeText(message.text)) continue
      if (current !== null) turns.push(current)
      current = {
        seq: Number.isSafeInteger(message.sourceSeq) ? message.sourceSeq : null,
        question: typeof message.text === 'string' ? message.text : '',
        tools: [],
        startedAt: message.at,
        endedAt: message.at,
        failed: false,
      }
      continue
    }
    if (current === null) continue
    if (message?.kind === 'error') current.failed = true
    if (Array.isArray(message?.process)) {
      for (const entry of message.process) {
        current.tools.push({
          name: typeof entry?.name === 'string' ? entry.name : '',
          arguments: entry?.arguments ?? null,
        })
      }
    }
    if (message?.at !== undefined) current.endedAt = message.at
  }
  if (current !== null) turns.push(current)
  return finishTurns(turns, cwd)
}

function finishTurns(turns, cwd) {
  const bySeq = {}
  const byIndex = []
  turns.forEach((turn, index) => {
    const insight = analyseTurn(turn, cwd)
    byIndex.push(insight)
    if (turn.seq !== null) bySeq[String(turn.seq)] = insight
  })
  return { turns: bySeq, byIndex, generatedAt: new Date().toISOString() }
}

function analyseTurn(turn, cwd) {
  const files = changedFiles(turn.tools, cwd)
  const risk = assessRisk(turn.tools, { cwd, files, failed: turn.failed })
  const intent = inferIntent(turn.question)
  return {
    seq: turn.seq,
    intent,
    risk,
    files,
    stats: {
      toolCount: turn.tools.length,
      fileCount: files.length,
      failed: turn.failed === true,
      startedAt: turn.startedAt ?? null,
      endedAt: turn.endedAt ?? null,
      durationMs: typeof turn.startedAt === 'number' && typeof turn.endedAt === 'number' ? Math.max(0, turn.endedAt - turn.startedAt) : null,
      tools: toolSummary(turn.tools),
    },
  }
}

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

export function inferIntent(question) {
  const text = typeof question === 'string' ? question : ''
  const compact = text.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim()
  const firstSentence = compact.split(/(?<=[。！？!?；;])/).find(part => part.trim() !== '') ?? compact
  const goal = goalFrom(firstSentence)
  const type = intentType(compact, firstSentence)
  return {
    goal,
    type: type.type,
    typeLabel: type.label,
    constraints: constraintsFrom(text),
    questionPreview: text.length > MAX_QUESTION_PREVIEW ? `${text.slice(0, MAX_QUESTION_PREVIEW).trimEnd()}…` : text,
    basis: '按用户原话与关键词推断',
    confidence: type.confidence,
  }
}

function goalFrom(sentence) {
  let goal = sentence
    .replace(/^[\s>*#-]+/, '')
    .replace(/^(?:你好[，,]\s*)?(?:请问[，,]?\s*)?(?:(?:请|麻烦|帮我|帮忙|我想要|我想|我要|我需要|能不能|可以|能否)\s*)+/i, '')
    .replace(/^下\s*/, '')
    .trim()
    .replace(/[。！？!?；;，,：:]+$/, '')
    .trim()
  goal = goal.replace(/^(?:一下|个)/, '').trim()
  if (goal.length > MAX_GOAL_CHARS) goal = `${goal.slice(0, MAX_GOAL_CHARS).trimEnd()}…`
  return goal || '（这条消息没有文字内容）'
}

function intentType(fullText, firstSentence) {
  if (FIX_RE.test(firstSentence) || FIX_RE.test(fullText.slice(0, 160))) return { type: 'fix', label: '修复问题', confidence: 'high' }
  if (QUESTION_FORM_RE.test(firstSentence.trim())) return { type: 'analyze', label: '调研分析', confidence: 'medium' }
  for (const [type, re, label] of INTENT_RULES) {
    if (re.test(fullText)) return { type, label, confidence: 'medium' }
  }
  return { type: 'talk', label: '对话讨论', confidence: 'low' }
}

function constraintsFrom(text) {
  const parts = String(text ?? '').split(/[。！？!?\n；;]/).map(part => part.trim()).filter(Boolean)
  const found = []
  for (const part of parts) {
    if (!/(必须|不要|不能|只能|仅|至少|最多|不超过|务必|要求|禁止)/.test(part)) continue
    const value = part.length > 60 ? `${part.slice(0, 60)}…` : part
    if (!found.includes(value)) found.push(value)
    if (found.length === MAX_CONSTRAINTS) break
  }
  return found
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function changedFiles(tools, cwd = '') {
  const files = []
  const index = new Map()
  const add = entry => {
    const displayPath = normalizePath(entry.path)
    if (displayPath === '') return
    const key = displayPath.toLowerCase()
    const existing = index.get(key)
    if (existing !== undefined) {
      existing.additions += entry.additions ?? 0
      existing.deletions += entry.deletions ?? 0
      if (entry.op === 'delete') existing.op = 'delete'
      existing.sources.add(entry.source)
      return
    }
    const record = {
      path: entry.path,
      displayPath,
      op: entry.op,
      outside: isOutsideWorkspace(entry.path, cwd),
      additions: entry.additions ?? 0,
      deletions: entry.deletions ?? 0,
      sources: new Set([entry.source]),
    }
    index.set(key, record)
    files.push(record)
    if (files.length > MAX_FILES) files.pop()
  }

  for (const tool of tools) {
    const name = String(tool?.name ?? '')
    const args = parseArguments(tool?.arguments)
    if (FILE_TOOLS.test(name)) {
      const entry = fileEntryFromTool(name, args)
      if (entry !== null) add(entry)
    } else if (PATCH_TOOLS.test(name)) {
      for (const entry of patchEntries(args)) add(entry)
    } else if (SHELL_TOOLS.test(name)) {
      for (const entry of shellFileEntries(args)) add(entry)
    }
  }

  return files.slice(0, MAX_FILES).map(file => ({
    path: file.path,
    displayPath: file.displayPath,
    op: file.op,
    outside: file.outside,
    additions: file.additions,
    deletions: file.deletions,
    source: [...file.sources].join(' / '),
  }))
}

function fileEntryFromTool(name, args) {
  const path = firstPath(args)
  if (path === null) return null
  const lower = name.toLowerCase()
  let op = 'modify'
  if (/delete|remove/.test(lower)) op = 'delete'
  else if (/write|create/.test(lower)) op = 'write'
  else if (/edit|replace|str_replace|modify/.test(lower)) op = 'modify'
  const additions = op === 'write' ? countLines(args?.content ?? args?.text ?? args?.new_string ?? args?.new_str) : countLines(args?.new_string ?? args?.new_str ?? args?.content)
  const deletions = op === 'delete' ? 0 : countLines(args?.old_string ?? args?.old_str)
  return { path, op, additions, deletions, source: '工具参数' }
}

function patchEntries(args) {
  const patch = rawPatch(args)
  if (patch === '') return []
  const entries = []
  const lines = patch.split('\n')
  let current = null
  const flush = () => {
    if (current !== null) entries.push(current)
    current = null
  }
  for (const line of lines) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
    if (header !== null) {
      flush()
      current = { path: header[2].trim(), op: header[1] === 'Add' ? 'write' : header[1] === 'Delete' ? 'delete' : 'modify', additions: 0, deletions: 0, source: '补丁内容' }
      continue
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line)
    if (move !== null && current !== null) {
      current.path = move[1].trim()
      continue
    }
    if (current === null) continue
    if (line.startsWith('+') && !line.startsWith('+++')) current.additions += 1
    else if (line.startsWith('-') && !line.startsWith('---')) current.deletions += 1
  }
  flush()
  return entries
}

function shellFileEntries(args) {
  const command = typeof args?.command === 'string' ? args.command : typeof args === 'string' ? args : ''
  if (command === '') return []
  const entries = []
  const patterns = [
    { op: 'write', re: /(?:Set-Content|Add-Content|Out-File)\s+(?:-Path\s+|-LiteralPath\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;|]+))/gi },
    { op: 'write', re: /New-Item\s+(?:-Path\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;|]+))[^\n]*-ItemType\s+File/gi },
    { op: 'delete', re: /Remove-Item\s+(?:-Path\s+|-LiteralPath\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;|]+))/gi },
    { op: 'write', re: /(?:^|[;&|]\s*)(?:echo|printf|cat)\b[^\n]*?>\s*(?:"([^"]+)"|'([^']+)'|([^\s;|&<>]+))/gi },
  ]
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern.re)) {
      const path = match[1] ?? match[2] ?? match[3]
      if (typeof path !== 'string' || path === '') continue
      if (/^\d+$/.test(path) || /^&?\d$/.test(path)) continue
      // `Remove-Item -Recurse $p` used to yield "-Recurse" and "$p" as files.
      if (path.startsWith('-') || path.startsWith('$') || path.startsWith('&')) continue
      entries.push({ path, op: pattern.op, additions: 0, deletions: 0, source: '命令推断' })
    }
  }
  return entries
}

function rawPatch(args) {
  if (typeof args === 'string') return args
  if (args === null || typeof args !== 'object') return ''
  for (const key of ['patch', 'input', 'text', 'diff', 'content']) {
    if (typeof args[key] === 'string' && args[key] !== '') return args[key]
  }
  return ''
}

function firstPath(args) {
  if (args === null || typeof args !== 'object') return null
  for (const key of ['file_path', 'filePath', 'path', 'target_file', 'filename', 'file', 'notebook_path', 'target']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

function normalizePath(value) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/').replace(/\/+/g, '/')
}

function isOutsideWorkspace(filePath, cwd) {
  const path = normalizePath(filePath)
  if (path === '') return false
  const absolute = /^[a-zA-Z]:\//.test(path) || path.startsWith('/')
  if (!absolute) return false
  const root = normalizePath(cwd).replace(/\/$/, '')
  if (root === '') return true
  return !(path.toLowerCase() === root.toLowerCase() || path.toLowerCase().startsWith(`${root.toLowerCase()}/`))
}

function countLines(value) {
  if (typeof value !== 'string' || value === '') return 0
  return value.split('\n').length
}

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

export function assessRisk(tools, options = {}) {
  const cwd = typeof options.cwd === 'string' ? options.cwd : ''
  const files = Array.isArray(options.files) ? options.files : []
  let score = 0
  const reasons = []
  const add = (weight, label, detail) => {
    score += weight
    if (reasons.length < 5) reasons.push({ label, detail: truncate(detail, MAX_REASON_CHARS), weight })
  }

  const fileTools = tools.filter(tool => FILE_TOOLS.test(String(tool?.name ?? '')))
  const patchTools = tools.filter(tool => PATCH_TOOLS.test(String(tool?.name ?? '')))
  const shellTools = tools.filter(tool => SHELL_TOOLS.test(String(tool?.name ?? '')))
  const netTools = tools.filter(tool => NETWORK_TOOLS.test(String(tool?.name ?? '')))
  const agentTools = tools.filter(tool => AGENT_TOOLS.test(String(tool?.name ?? '')))

  if (fileTools.length > 0) {
    const weight = Math.min(36, fileTools.length * 12)
    add(weight, '文件改动', `${fileTools.length} 次文件写入或编辑`)
    for (const tool of fileTools.slice(0, 3)) {
      const args = parseArguments(tool?.arguments)
      const path = firstPath(args) ?? '（未提供路径）'
      const op = /delete|remove/i.test(String(tool?.name ?? '')) ? 'delete' : 'write'
      const extra = op === 'delete' ? 30 : 0
      add(extra, op === 'delete' ? '删除文件' : '修改文件', normalizePath(path))
    }
  }

  if (patchTools.length > 0) {
    add(Math.min(30, patchTools.length * 15), '应用补丁', `${patchTools.length} 个补丁`)
  }

  if (shellTools.length > 0) {
    add(18, '执行命令', `${shellTools.length} 条 Shell / PowerShell 命令`)
    for (const tool of shellTools.slice(0, 4)) {
      const args = parseArguments(tool?.arguments)
      const command = typeof args?.command === 'string' ? args.command : typeof args === 'string' ? args : ''
      if (command === '') continue
      for (const rule of SHELL_RULES) {
        if (!rule.re.test(command)) continue
        add(rule.weight, rule.label, command)
      }
    }
  }

  if (netTools.length > 0) add(Math.min(10, netTools.length * 2), '外部网络访问', `${netTools.length} 次搜索或抓取`)
  if (agentTools.length > 0) add(Math.min(20, agentTools.length * 10), '委派子代理', `${agentTools.length} 次委派`)
  if (options.failed === true) add(8, '本轮未完成', '失败可能留下半完成状态')

  const outside = files.filter(file => file.outside === true)
  if (outside.length > 0) add(Math.min(30, outside.length * 15), '工作区外写入', outside.map(file => file.displayPath).join('、'))

  score = Math.max(0, Math.min(100, score))
  const ranked = RISK_LEVELS.find(item => score >= item.at) ?? RISK_LEVELS[RISK_LEVELS.length - 1]
  return {
    score,
    level: ranked.level,
    label: ranked.label,
    reasons: reasons.sort((a, b) => b.weight - a.weight),
    summary: riskSummary(tools, files),
    basis: '按工具类型、命令内容与路径位置估算',
  }
}

function riskSummary(tools, files) {
  if (tools.length === 0) return '本轮没有调用工具'
  const parts = []
  if (files.length > 0) parts.push(`${files.length} 个文件`)
  const shells = tools.filter(tool => SHELL_TOOLS.test(String(tool?.name ?? ''))).length
  if (shells > 0) parts.push(`${shells} 条命令`)
  const writes = tools.filter(tool => FILE_TOOLS.test(String(tool?.name ?? '')) || PATCH_TOOLS.test(String(tool?.name ?? ''))).length
  if (writes > 0) parts.push(`${writes} 次编辑`)
  return parts.length === 0 ? `${tools.length} 次工具调用` : parts.join(' · ')
}

function toolSummary(tools) {
  const counts = new Map()
  for (const tool of tools) {
    const name = String(tool?.name ?? '').trim() || '工具'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// Shared event helpers (kept in step with the projection in index.js)
// ---------------------------------------------------------------------------

function parseArguments(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '') return null
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return { raw: text }
  }
}

function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => {
    if (block?.type === 'text') return [block.text]
    if (block?.type === 'tool-call') return [block.name, block.arguments]
    if (block?.type === 'tool-result') return contentText(block.content)
    return []
  }).filter(value => typeof value === 'string' && value.trim() !== '').join('\n')
}

function isRuntimeContextText(text) {
  return typeof text === 'string' && text.trimStart().startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')
}

const INJECTED_USER_KINDS = new Set(['skill-catalog', 'runtime-context', 'time-context', 'tool-jobs'])

function isInjectedUserSource(source) {
  return typeof source?.kind === 'string' && INJECTED_USER_KINDS.has(source.kind)
}

/**
 * Stored v5 rows keep only the text, so recognise the same harness snapshots by
 * their stable openers. A human sentence that happens to start with one of
 * these exact prefixes is an acceptable false positive compared with handing a
 * real request's tools to a clock note.
 */
function isHarnessNoticeText(text) {
  if (typeof text !== 'string') return false
  if (isRuntimeContextText(text)) return true
  const head = text.trimStart()
  return head.startsWith('Time sampled while preparing turn ') || /^background job [\w-]+ \(/.test(head)
}

function truncate(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}
