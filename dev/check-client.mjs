// Load one DSH web page and report whether the Synapse client module survived
// boot. Development-only diagnostic used to verify the client-module id fix.
//
//   node dev/check-client.mjs <url> [waitMs]
//
const url = process.argv[2]
const waitMs = Number(process.argv[3] ?? 5000)
const target = await fetch(`http://127.0.0.1:9333/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then(response => response.json())
const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
const exceptions = []
let nextId = 1
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.exceptionThrown') {
    const detail = message.params?.exceptionDetails
    exceptions.push(detail?.exception?.description ?? detail?.text ?? 'unknown exception')
    return
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
    exceptions.push(`console: ${(message.params.args ?? []).map(arg => arg.value ?? arg.description ?? '').join(' ')}`)
    return
  }
  const entry = message.id === undefined ? undefined : pending.get(message.id)
  if (entry === undefined) return
  pending.delete(message.id)
  if (message.error !== undefined) entry.reject(new Error(message.error.message))
  else entry.resolve(message.result)
})
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await new Promise(resolve => setTimeout(resolve, waitMs))
const { result } = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    url: location.href,
    hasSwitch: Boolean(document.querySelector('.dsh-synapse-switch')),
    hasErrorText: /did not activate|duplicate factory|web boot|import failed/i.test(document.body.innerText),
    bodyTail: document.body.innerText.slice(-900)
  })`,
  returnByValue: true,
})
console.log('PAGE', result.value)
console.log('EXCEPTIONS', JSON.stringify(exceptions.slice(-8), null, 2))
await send('Page.close')
socket.close()
