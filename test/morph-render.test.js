// The canvas must never replace the whole tree: a rebuild between mousedown and
// mouseup destroys the click target, and the browser then dispatches no click at
// all (W3C uievents #141). Patching in place keeps the node under the pointer.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')

test('patches renders into the live tree instead of replacing the page', () => {
  assert.match(source, /function morphInto\(container, html\)/)
  assert.match(source, /function morphChildren\(from, to\)/)
  // The render entry point and the streaming answer both morph.
  assert.match(source, /morphInto\(app, `/)
  assert.match(source, /morphInto\(answer, /)
  // No wholesale assignment may come back.
  assert.doesNotMatch(source, /app\.innerHTML\s*=/)
  assert.doesNotMatch(source, /answer\.innerHTML\s*=/)
})

test('keys morph matching on the card and thread identities', () => {
  // A card keeps its node across renders because `data-card-id` identifies it;
  // sidebar rows and the detail view are matched by `data-thread`.
  const keys = /const MORPH_KEY_ATTRIBUTES = \[([^\]]+)\]/.exec(source)
  assert.ok(keys !== null, 'key attribute list is declared')
  for (const attribute of ['data-card-id', 'data-thread', 'id']) {
    assert.ok(keys[1].includes(`'${attribute}'`), `${attribute} participates in matching`)
  }
})

test('keeps the caret owner\'s children but still patches its attributes', () => {
  // Typing in the composer (or a live selection) must survive a projection tick,
  // but a *clicked* button is document.activeElement too — treating that as
  // "owns the caret" froze its subtree, so the clicked sidebar row never got its
  // `active` class and no row looked selected after a switch.
  assert.match(source, /function morphKeepsChildren\(node\)/)
  assert.match(source, /if \(!morphKeepsChildren\(from\)\) morphChildren\(from, to\)/)
  assert.match(source, /node instanceof HTMLTextAreaElement/)
  assert.match(source, /node\.isContentEditable === true/)
  assert.doesNotMatch(source, /node === document\.activeElement/)

  const patchIndex = source.indexOf("if (from.getAttribute(attribute.name) !== attribute.value)")
  const guardIndex = source.indexOf('if (!morphKeepsChildren(from)) morphChildren(from, to)')
  assert.ok(patchIndex > 0, 'attributes are still patched')
  assert.ok(guardIndex > patchIndex, 'attributes are patched before children are touched')
})
