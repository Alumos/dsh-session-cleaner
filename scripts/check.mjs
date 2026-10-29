// CI gate for the plugin bundle: manifest shape, display metadata, patch file,
// icon budget and the Host half's exported lifecycle. Run with `node scripts/check.mjs`.
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const ok = (condition, message) => {
  if (!condition) problems.push(message)
}
const resolve = (...parts) => path.join(root, ...parts)
const readJson = async (file) => JSON.parse(await readFile(resolve(file), 'utf8'))

const pkg = await readJson('package.json')
ok(pkg.name === 'dsh-session-cleaner', 'package.json name must be dsh-session-cleaner')
ok(typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version), 'package.json version must be semver')
ok(pkg.type === 'module', 'package.json type must be module')
ok(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch must be ./cordis.patch.yml')
ok(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform must be web')
ok(pkg.dsh?.client?.immediately === true, 'dsh.client.immediately must be true')
ok(Array.isArray(pkg.dsh?.client?.inject), 'dsh.client.inject must be an array')
ok(pkg.exports?.['.'] === './index.js', 'exports["."] must be ./index.js')
ok(pkg.exports?.['./client'] === './client.js', 'exports["./client"] must be ./client.js')
ok(pkg.exports?.['./icon'] === './icon.svg', 'exports["./icon"] must be ./icon.svg')

for (const file of ['index.js', 'client.js', 'README.md', 'LICENSE', 'CHANGELOG.md', 'cordis.patch.yml', 'icon.svg']) {
  try {
    const stats = await stat(resolve(file))
    ok(stats.isFile() && stats.size > 0, `${file} must be a non-empty file`)
  } catch {
    problems.push(`missing ${file}`)
  }
}

const patch = await readFile(resolve('cordis.patch.yml'), 'utf8')
ok(/-\s*insert:/.test(patch), 'cordis.patch.yml must insert the plugin')
ok(/id:\s*dsh-session-cleaner/.test(patch), 'cordis.patch.yml must use id dsh-session-cleaner')
ok(/name:\s*['"]?dsh-session-cleaner['"]?/.test(patch), 'cordis.patch.yml must use name dsh-session-cleaner')

for (const locale of ['zh', 'en']) {
  const dict = await readJson(`locale/${locale}.json`)
  ok(typeof dict.meta?.title === 'string' && dict.meta.title.length > 0, `locale/${locale}.json needs meta.title`)
  ok(typeof dict.meta?.description === 'string' && dict.meta.description.length > 0, `locale/${locale}.json needs meta.description`)
}

const icon = await stat(resolve('icon.svg'))
ok(icon.size <= 256 * 1024, 'icon must be at most 256 KiB')

const host = await import(resolve('index.js').replace(/\\/g, '/'))
ok(host.name === 'dsh-session-cleaner', 'index.js must export name dsh-session-cleaner')
ok(typeof host.apply === 'function', 'index.js must export apply(ctx, config)')
ok(Array.isArray(host.inject) && host.inject.includes('webServer'), 'index.js must inject webServer')

for (const file of pkg.files ?? []) {
  if (file.includes('*')) continue
  try {
    await stat(resolve(file))
  } catch {
    problems.push(`package.json files entry ${file} does not exist`)
  }
}

if (problems.length > 0) {
  console.error(`✗ plugin check failed (${problems.length})`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`✓ plugin check passed (dsh-session-cleaner@${pkg.version}, ${pkg.files.length} shipped entries)`)
