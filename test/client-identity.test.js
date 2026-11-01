import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/**
 * The DSH client-modules loader keys factories by the bundle's package id. When
 * this registration id does not match `package.json.name`, the loader thinks
 * the bundle never registered, requests it a second time, and the second
 * registration throws "duplicate factory registration" — a fatal web-boot
 * error that drops the app into recovery mode.
 */
test('client module id matches the package name', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const match = /__ModuleLoader__\.load\(\{[\s\S]{0,400}?\bid:\s*'([^']+)'/.exec(client)
  assert.notEqual(match, null, 'client.js must register through __ModuleLoader__.load')
  assert.equal(match[1], packageJson.name)
})
