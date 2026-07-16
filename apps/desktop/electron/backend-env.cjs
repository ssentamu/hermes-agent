const path = require('node:path')

// Match the POSIX fallback surface used by the Python terminal environment.
// macOS apps launched from Finder/Dock often inherit only /usr/bin:/bin:/usr/sbin:/sbin,
// which misses Apple Silicon Homebrew and user-installed CLI tools such as codex.
const POSIX_SANE_PATH_ENTRIES = Object.freeze([
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/sbin',
  '/usr/local/bin',
  '/usr/sbin',
  '/usr/bin',
  '/sbin',
  '/bin'
])

function delimiterForPlatform(platform = process.platform) {
  return platform === 'win32' ? ';' : ':'
}

function pathModuleForPlatform(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path.posix
}

function pathEnvKey(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return 'PATH'
  return Object.keys(env || {}).find(key => key.toUpperCase() === 'PATH') || 'PATH'
}

function currentPathValue(env = process.env, platform = process.platform) {
  const key = pathEnvKey(env, platform)
  return env?.[key] || ''
}

function appendUniquePathEntries(entries, { delimiter = path.delimiter } = {}) {
  const seen = new Set()
  const ordered = []

  for (const entry of entries) {
    if (!entry) continue
    const parts = Array.isArray(entry) ? entry : String(entry).split(delimiter)
    for (const part of parts) {
      if (!part || seen.has(part)) continue
      seen.add(part)
      ordered.push(part)
    }
  }

  return ordered.join(delimiter)
}

function buildDesktopBackendPath({
  hermesHome,
  venvRoot,
  currentPath = '',
  platform = process.platform,
  pathModule = pathModuleForPlatform(platform)
} = {}) {
  const delimiter = delimiterForPlatform(platform)
  const hermesNodeBin = hermesHome ? pathModule.join(hermesHome, 'node', 'bin') : null
  const venvBin = venvRoot ? pathModule.join(venvRoot, platform === 'win32' ? 'Scripts' : 'bin') : null
  const saneEntries = platform === 'win32' ? [] : POSIX_SANE_PATH_ENTRIES

  return appendUniquePathEntries([hermesNodeBin, venvBin, currentPath, saneEntries], { delimiter })
}

function normalizeHermesHomeRoot(hermesHome, { pathModule = pathModuleForPlatform(process.platform) } = {}) {
  if (!hermesHome) return hermesHome
  const resolved = pathModule.resolve(String(hermesHome))
  const parent = pathModule.dirname(resolved)
  if (pathModule.basename(parent).toLowerCase() === 'profiles') {
    return pathModule.dirname(parent)
  }
  return resolved
}

function buildDesktopBackendEnv({
  hermesHome,
  pythonPathEntries = [],
  venvRoot,
  currentEnv = process.env,
  platform = process.platform,
  pathModule = pathModuleForPlatform(platform)
} = {}) {
  const delimiter = delimiterForPlatform(platform)
  const currentPythonPath = currentEnv?.PYTHONPATH || ''
  const key = pathEnvKey(currentEnv, platform)

  // Filter PYTHONPATH entries that reference a different Python version than
  // the venv. A polluted PYTHONPATH (e.g. with python3.13/site-packages while
  // the venv runs 3.11) causes native extension load failures like
  // "No module named 'pydantic_core._pydantic_core'".
  const sanitizedPythonPath = filterIncompatiblePythonPath(currentPythonPath, { venvRoot, delimiter, pathModule })

  return {
    PYTHONPATH: appendUniquePathEntries([...pythonPathEntries, sanitizedPythonPath], { delimiter }),
    [key]: buildDesktopBackendPath({
      hermesHome,
      venvRoot,
      currentPath: currentPathValue(currentEnv, platform),
      platform,
      pathModule
    })
  }
}

// Return a PYTHONPATH string with entries from incompatible Python versions
// removed. Detects the venv's major.minor version and drops any entry whose
// path contains a different pythonX.Y segment.
function filterIncompatiblePythonPath(pythonPath, { venvRoot, delimiter, pathModule } = {}) {
  if (!pythonPath || !venvRoot) return pythonPath || ''

  const venvVersion = detectVenvPythonVersion(venvRoot, pathModule)
  if (!venvVersion) return pythonPath // can't detect — pass through unchanged

  const entries = String(pythonPath).split(delimiter).filter(Boolean)
  const filtered = entries.filter(entry => {
    // Extract pythonX.Y from the path
    const m = entry.match(/python(\d+)\.(\d+)/)
    if (!m) return true // no version marker — keep it
    return m[1] === venvVersion.major && m[2] === venvVersion.minor
  })

  return filtered.join(delimiter)
}

// Detect the Python version from a venv's lib directory name.
// E.g. venv/lib/python3.11/site-packages → { major: '3', minor: '11' }
function detectVenvPythonVersion(venvRoot, pathModule = path) {
  try {
    const libDir = pathModule.join(venvRoot, 'lib')
    if (!require('fs').existsSync(libDir)) return null
    const entries = require('fs').readdirSync(libDir)
    for (const entry of entries) {
      const m = entry.match(/^python(\d+)\.(\d+)$/)
      if (m) return { major: m[1], minor: m[2] }
    }
  } catch (_) { /* permissions or race */ }
  return null
}

module.exports = {
  POSIX_SANE_PATH_ENTRIES,
  appendUniquePathEntries,
  buildDesktopBackendEnv,
  buildDesktopBackendPath,
  delimiterForPlatform,
  detectVenvPythonVersion,
  filterIncompatiblePythonPath,
  normalizeHermesHomeRoot,
  pathEnvKey
}
