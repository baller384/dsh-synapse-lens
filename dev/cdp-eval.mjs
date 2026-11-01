// Evaluate an expression in a fresh headless page and print the JSON result.
//   node dev/cdp-eval.mjs <url> "<expression>"
const url = process.argv[2]
const expression = process.argv[3]
const target = await fetch(`http://127.0.0.1:9333/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then(response => response.json())
const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
let nextId = 1
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
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
await send('Page.enable')
await send('Runtime.enable')
await new Promise(resolve => setTimeout(resolve, 3000))
const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
console.log(JSON.stringify(result.result.value ?? result.result.description, null, 2))
await send('Page.close')
socket.close()
