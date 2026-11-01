// The view switch is a page-level control: users want to move it out of the way
// of whatever they are reading. Dragging must keep it reachable, survive a
// reload, reset on demand, and never eat the buttons inside it.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

function slice(from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start + 1)
  assert.ok(start > 0, `missing marker: ${from}`)
  assert.ok(end > start, `missing end marker: ${to}`)
  return source.slice(start, end)
}

/** Load the drag arithmetic + storage helpers into a bare context. */
function helpers() {
  const code = slice('const SWITCH_POSITION_KEY', 'module.exports.inject')
  const context = { Math, JSON, Number }
  vm.createContext(context)
  vm.runInContext(`${code}
    globalThis.__switch = {
      clampSwitchPosition, readSwitchPosition, writeSwitchPosition, clearSwitchPosition,
      SWITCH_POSITION_KEY, SWITCH_MARGIN, SWITCH_STEP,
    }`, context)
  return context.__switch
}

test('clamps the dragged pill inside the viewport with a grab margin', () => {
  const helpersApi = helpers()
  const viewport = { width: 1000, height: 800 }
  const size = { width: 160, height: 34 }
  const margin = helpersApi.SWITCH_MARGIN

  assert.deepEqual(
    { ...helpersApi.clampSwitchPosition({ left: -50, top: -20 }, viewport, size) },
    { left: margin, top: margin },
  )
  assert.deepEqual(
    { ...helpersApi.clampSwitchPosition({ left: 9999, top: 9999 }, viewport, size) },
    { left: 1000 - 160 - margin, top: 800 - 34 - margin },
  )
  // Fractional drags are rounded so the stored value stays an integer.
  assert.deepEqual(
    { ...helpersApi.clampSwitchPosition({ left: 40.6, top: 12.2 }, viewport, size) },
    { left: 41, top: 12 },
  )
  // A viewport smaller than the pill must not push it off the top-left corner.
  assert.deepEqual(
    { ...helpersApi.clampSwitchPosition({ left: 500, top: 500 }, { width: 100, height: 20 }, { width: 160, height: 34 }) },
    { left: margin, top: margin },
  )
})

test('round-trips the stored position and ignores junk', () => {
  const helpersApi = helpers()
  const store = new Map()
  const storage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
  }

  assert.equal(helpersApi.readSwitchPosition(storage), null)

  helpersApi.writeSwitchPosition(storage, { left: 12, top: 34 })
  assert.equal(store.get(helpersApi.SWITCH_POSITION_KEY), '{"left":12,"top":34}')
  assert.deepEqual({ ...helpersApi.readSwitchPosition(storage) }, { left: 12, top: 34 })

  store.set(helpersApi.SWITCH_POSITION_KEY, '{not json')
  assert.equal(helpersApi.readSwitchPosition(storage), null)

  store.set(helpersApi.SWITCH_POSITION_KEY, JSON.stringify({ left: 'x', top: 3 }))
  assert.equal(helpersApi.readSwitchPosition(storage), null)

  // A storage that throws (private mode) must degrade, not crash the pill.
  const hostile = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
    removeItem: () => { throw new Error('denied') },
  }
  assert.equal(helpersApi.readSwitchPosition(hostile), null)
  assert.doesNotThrow(() => helpersApi.writeSwitchPosition(hostile, { left: 1, top: 1 }))
  assert.doesNotThrow(() => helpersApi.clearSwitchPosition(hostile))

  helpersApi.clearSwitchPosition(storage)
  assert.equal(helpersApi.readSwitchPosition(storage), null)
})

test('the pill ships a grip wired for pointer, keyboard, reset and cleanup', () => {
  assert.match(source, /class="dsh-synapse-grip"/)
  assert.match(source, /grip\.addEventListener\('pointerdown'/)
  assert.match(source, /grip\.setPointerCapture\(event\.pointerId\)/)
  assert.match(source, /grip\.addEventListener\('pointermove'/)
  assert.match(source, /grip\.addEventListener\('pointerup', finishSwitchDrag\)/)
  assert.match(source, /grip\.addEventListener\('pointercancel', finishSwitchDrag\)/)
  assert.match(source, /grip\.addEventListener\('dblclick'/)
  assert.match(source, /ArrowLeft/)
  assert.match(source, /is-dragging/)
  assert.match(source, /window\.addEventListener\('resize', keepSwitchInView\)/)
  assert.match(source, /window\.removeEventListener\('resize', keepSwitchInView\)/)
  // The grab handle must not become a drag region of the window chrome.
  assert.match(source, /\.dsh-synapse-grip\{[^}]*cursor:grab[^}]*\}/)
  assert.match(source, /\.dsh-synapse-grip\{[^}]*\-webkit-app-region:no-drag/)
})
