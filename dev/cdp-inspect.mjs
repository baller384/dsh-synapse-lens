// Drive the already-running headless Edge through CDP: navigate, inspect the
// first card footer, and save a screenshot. Development-only helper.
//
//   node dev/cdp-inspect.mjs <url> <output.png> [waitMs]
//
import { writeFile } from 'node:fs/promises'

const url = process.argv[2] ?? 'http://127.0.0.1:6123/synapse/?open=t2:6:risk'
const out = process.argv[3] ?? 'dev/cdp.png'
const waitMs = Number(process.argv[4] ?? 2500)

const target = await fetch(`http://127.0.0.1:9333/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then(response => response.json())
if (target.webSocketDebuggerUrl === undefined) throw new Error(`no debugger url: ${JSON.stringify(target)}`)
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
  if (message.id === undefined) return
  const entry = pending.get(message.id)
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
await new Promise(resolve => setTimeout(resolve, waitMs))
const clickSelector = process.argv[5]
if (clickSelector !== undefined) {
  await send('Runtime.evaluate', { expression: `window.confirm=()=>true;document.querySelector(${JSON.stringify(clickSelector)})?.click()` })
  await new Promise(resolve => setTimeout(resolve, 2000))
}

const expression = `(() => {
  const card = document.querySelector('.thread-card')
  const footer = card?.querySelector('footer')
  const buttons = [...(footer?.querySelectorAll('button') ?? [])]
  return JSON.stringify({
    card: card === null ? null : card.getBoundingClientRect().toJSON(),
    footer: footer === null ? null : footer.outerHTML,
    footerRect: footer === null ? null : footer.getBoundingClientRect().toJSON(),
    buttons: buttons.map(button => ({
      text: button.textContent.trim(),
      display: getComputedStyle(button).display,
      color: getComputedStyle(button).color,
      rect: button.getBoundingClientRect().toJSON(),
    })),
  }, null, 2)
})()`
const result = await send('Runtime.evaluate', { expression, returnByValue: true })
console.log(result.result.value)

const shot = await send('Page.captureScreenshot', { format: 'png' })
await writeFile(out, Buffer.from(shot.data, 'base64'))
console.log(`screenshot ${out}`)
await send('Page.close')
socket.close()
