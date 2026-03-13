/* ===================================
   release.mjs
   -----------------------------------
   - Release build script for Stitch.
   - Reads version and notes from RELEASE.json, compiles TypeScript,
     bundles the server, packages the Electron installer, and logs
     the release to RELEASES.json in the output folder.
   - Usage: edit RELEASE.json, then run: npm run release
   =================================== */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname    = fileURLToPath(new URL('.', import.meta.url))
const ROOT         = resolve(__dirname, '..')
const RELEASES_DIR = resolve(ROOT, '..', 'release')
const LOG_FILE     = join(RELEASES_DIR, 'RELEASES.json')

// =============================
// Part 1 — Read RELEASE.json
// =============================

const releasePath = join(ROOT, 'RELEASE.json')
if (!existsSync(releasePath)) {
  console.error('\n✗ RELEASE.json not found in project root.')
  process.exit(1)
}

let version, notes
try {
  ;({ version, notes } = JSON.parse(readFileSync(releasePath, 'utf8')))
} catch {
  console.error('\n✗ RELEASE.json is not valid JSON.')
  process.exit(1)
}

// =============================
// Part 2 — Validation
// =============================

if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error(`\n✗ Invalid version "${version}". Use semver format: 1.2.3`)
  process.exit(1)
}

if (!notes?.trim()) {
  console.error('\n✗ Release notes cannot be empty in RELEASE.json.')
  process.exit(1)
}

const outputDir = join(RELEASES_DIR, `v${version}`)
if (existsSync(outputDir)) {
  console.error(`\n✗ v${version} already exists at:\n  ${outputDir}\n\nBump the version in RELEASE.json before releasing again.`)
  process.exit(1)
}

// =============================
// Part 3 — Sync package.json Version
// =============================

const pkgPath = join(ROOT, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const prevVersion = pkg.version
pkg.version = version
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

// =============================
// Part 4 — Build
// =============================

// Use forward slashes — electron-builder handles them correctly on Windows.
const outputDirFwd = outputDir.replace(/\\/g, '/')

console.log(`\nBuilding Stitch v${version}${prevVersion !== version ? ` (was v${prevVersion})` : ''}\n`)

try {
  console.log('  [1/3] Compiling TypeScript...')
  execSync('npx tsc', { cwd: ROOT, stdio: 'inherit' })

  console.log('\n  [2/3] Bundling server...')
  execSync(
    'npx esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/server.mjs --external:electron',
    { cwd: ROOT, stdio: 'inherit' }
  )

  console.log(`\n  [3/3] Packaging installer → ${outputDir}\n`)
  mkdirSync(outputDir, { recursive: true })

  // Pass the versioned output dir via CLI flag — more reliable than the programmatic API.
  execSync(
    `npx electron-builder --win -c.directories.output="${outputDirFwd}" -c.extraMetadata.version="${version}"`,
    { cwd: ROOT, stdio: 'inherit' }
  )

} catch (err) {
  console.error('\n✗ Build failed:', err?.message ?? err)
  // Revert package.json version so nothing is left in a broken state.
  pkg.version = prevVersion
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  console.error(`  package.json version reverted to ${prevVersion}`)
  process.exit(1)
}

// =============================
// Part 5 — Log the Release
// =============================

mkdirSync(RELEASES_DIR, { recursive: true })

let log = { releases: [] }
if (existsSync(LOG_FILE)) {
  try {
    log = JSON.parse(readFileSync(LOG_FILE, 'utf8'))
  } catch {
    // Corrupted log — start fresh.
  }
}

log.releases.unshift({
  version,
  date:      new Date().toISOString().slice(0, 10),
  builtAt:   new Date().toISOString(),
  notes,
  installer: `v${version}/Stitch Setup ${version}.exe`
})

writeFileSync(LOG_FILE, JSON.stringify(log, null, 2) + '\n')

console.log(`\n✓ Released Stitch v${version}`)
console.log(`  Installer → ${outputDir}`)
console.log(`  Release log → ${LOG_FILE}\n`)
