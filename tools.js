/**
 * Host-side agent tools for dsh-toolbox-gjkt.
 *
 * These are hand-written, already-compiled tool definitions (raw JSON Schema),
 * so this module needs NO import of @deepseek-ai/dsh-tools. That package is not
 * present in the profile's node_modules, and linked bundles resolve imports from
 * their own directory, so a bare import would fail to resolve at runtime.
 *
 * Only Node built-ins are used: node:os, node:child_process, node:path.
 * Encoding detection relies on the WHATWG TextDecoder built into Node 22+,
 * which supports gbk / gb18030 / utf-16le with fatal mode — no iconv-lite.
 */

import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Same density heuristic as DSH core tokenMeter.estimateMessage. */
function est(text) {
  return Math.ceil(String(text == null ? '' : text).length / 4) + 4
}

/** JSON.stringify with a safe fallback, for schema-cost estimation. */
function json(value) {
  try { return JSON.stringify(value) ?? '' } catch (_) { return '' }
}

/** Required fields live on the PARENT object, never on the property itself. */
function obj(properties, required = []) {
  return { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) }
}
const str = (description) => ({ type: 'string', description })
const bool = (description) => ({ type: 'boolean', description })
const int = (description) => ({ type: 'integer', description })
const arr = (items, description) => ({ type: 'array', items, ...(description ? { description } : {}) })

function renderJson(_args, value) {
  return [{ type: 'text', text: json(value) }]
}

// ---------------------------------------------------------------------------
// encoding detection + decode (learned from lhh010/dsh-bash-encoding)
// ---------------------------------------------------------------------------

/**
 * Detect the encoding of a raw byte buffer.
 * Order matters: BOM -> pure ASCII -> UTF-16 NUL pattern -> strict UTF-8 ->
 * GBK -> GB18030 -> latin1. Pure ASCII must be excluded first, otherwise an
 * ASCII-only run looks like UTF-16 to a naive detector.
 */
function detectEncoding(buf) {
  if (!buf || buf.length === 0) return { encoding: 'utf-8', confidence: 'empty', offset: 0 }
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return { encoding: 'utf-8', confidence: 'bom', offset: 3 }
  if (buf[0] === 0xFF && buf[1] === 0xFE) return { encoding: 'utf-16le', confidence: 'bom', offset: 2 }
  if (buf[0] === 0xFE && buf[1] === 0xFF) return { encoding: 'utf-16be', confidence: 'bom', offset: 2 }

  let high = 0
  let nulOdd = 0
  let nulEven = 0
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    if (b >= 0x80) high++
    if (b === 0) { if (i % 2 === 0) nulEven++; else nulOdd++ }
  }
  if (high === 0) return { encoding: 'utf-8', confidence: 'ascii', offset: 0 }

  const pairs = Math.floor(buf.length / 2)
  if (pairs > 0 && nulOdd / pairs > 0.5 && nulEven / pairs < 0.1) return { encoding: 'utf-16le', confidence: 'nul-pattern', offset: 0 }
  if (pairs > 0 && nulEven / pairs > 0.5 && nulOdd / pairs < 0.1) return { encoding: 'utf-16be', confidence: 'nul-pattern', offset: 0 }

  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return { encoding: 'utf-8', confidence: 'strict', offset: 0 } } catch (_) {}
  try { new TextDecoder('gbk', { fatal: true }).decode(buf); return { encoding: 'gbk', confidence: 'heuristic', offset: 0 } } catch (_) {}
  try { new TextDecoder('gb18030', { fatal: true }).decode(buf); return { encoding: 'gb18030', confidence: 'heuristic', offset: 0 } } catch (_) {}
  return { encoding: 'latin1', confidence: 'fallback', offset: 0 }
}

function decodeBytes(buf, forced) {
  if (!buf || buf.length === 0) return { text: '', encoding: forced || 'utf-8', confidence: 'empty' }
  let info
  if (forced) {
    // For a forced encoding, still strip a matching BOM.
    let offset = 0
    if (/utf-?8/i.test(forced) && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) offset = 3
    else if (/utf-16le/i.test(forced) && buf[0] === 0xFF && buf[1] === 0xFE) offset = 2
    else if (/utf-16be/i.test(forced) && buf[0] === 0xFE && buf[1] === 0xFF) offset = 2
    info = { encoding: forced, confidence: 'forced', offset }
  } else {
    info = detectEncoding(buf)
  }
  let text
  try {
    text = new TextDecoder(info.encoding, { fatal: false }).decode(buf.subarray(info.offset))
  } catch (_) {
    try { text = new TextDecoder('latin1').decode(buf.subarray(info.offset)) }
    catch (__) { text = '' }
  }
  return { text, encoding: info.encoding, confidence: info.confidence }
}

// ---------------------------------------------------------------------------
// tool 1: sysinfo
// ---------------------------------------------------------------------------

function sysinfoTool() {
  return {
    name: 'sysinfo',
    description: 'Report OS, CPU, memory and network-interface information of the machine running DSH. Read-only; no file, shell or network access. CPU usage is sampled over an optional short window; network interface addresses are listed, but rx/tx traffic bytes are not available from Node built-ins.',
    parameters: obj({
      sampleMs: int('Optional CPU sampling window in milliseconds (100-5000). Omit or 0 to skip CPU usage percentage.')
    }),
    output: {
      schema: obj({
        os: obj({
          hostname: { type: 'string' }, platform: { type: 'string' }, arch: { type: 'string' },
          release: { type: 'string' }, uptimeSeconds: { type: 'number' }, cpuCount: { type: 'integer' }
        }, ['hostname', 'platform', 'arch', 'release', 'uptimeSeconds', 'cpuCount']),
        cpu: obj({
          model: { type: 'string' }, usagePercent: { type: 'number' }, loadavg1m: { type: 'number' }
        }, ['model', 'loadavg1m']),
        memory: obj({
          totalBytes: { type: 'number' }, freeBytes: { type: 'number' }, freePercent: { type: 'number' }
        }, ['totalBytes', 'freeBytes', 'freePercent']),
        network: arr(obj({
          name: { type: 'string' }, addresses: arr({ type: 'string' }), mac: { type: 'string' }
        }, ['name', 'addresses'])),
        notes: arr({ type: 'string' })
      }, ['os', 'cpu', 'memory', 'network', 'notes']),
      render: renderJson
    },
    async execute(args, exec) {
      let sampleMs = args && args.sampleMs
      if (sampleMs === undefined) sampleMs = 0
      if (!Number.isInteger(sampleMs) || sampleMs < 0 || sampleMs > 5000) throw new Error('sampleMs must be an integer between 0 and 5000')
      const totalIdle = () => os.cpus().reduce((s, c) => s + c.times.idle, 0)
      const totalAll = () => os.cpus().reduce((s, c) => s + Object.values(c.times).reduce((a, b) => a + b, 0), 0)
      const aIdle = sampleMs > 0 ? totalIdle() : 0
      const aAll = sampleMs > 0 ? totalAll() : 0
      if (sampleMs > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, sampleMs)
          const signal = exec && exec.signal
          if (signal) {
            if (signal.aborted) { clearTimeout(timer); return reject(signal.reason) }
            signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
          }
        })
      }
      const cpus = os.cpus()
      const bIdle = sampleMs > 0 ? totalIdle() : aIdle
      const bAll = sampleMs > 0 ? totalAll() : aAll
      const allDelta = bAll - aAll
      const busyDelta = allDelta - (bIdle - aIdle)
      const usage = sampleMs > 0 && allDelta > 0 ? Number((100 * busyDelta / allDelta).toFixed(2)) : undefined
      const total = os.totalmem()
      const free = os.freemem()
      const network = Object.entries(os.networkInterfaces()).map(([name, infos]) => ({
        name,
        addresses: (infos || []).map(i => i.address).filter(Boolean),
        mac: (infos || []).map(i => i.mac).find(m => m && m !== '00:00:00:00:00:00') || ''
      }))
      return {
        os: {
          hostname: os.hostname(), platform: os.platform(), arch: os.arch(),
          release: os.release(), uptimeSeconds: Number(os.uptime().toFixed(0)), cpuCount: cpus.length
        },
        cpu: {
          model: cpus[0] ? cpus[0].model : 'unknown',
          ...(usage !== undefined ? { usagePercent: usage } : {}),
          loadavg1m: Number(os.loadavg()[0].toFixed(2))
        },
        memory: {
          totalBytes: total, freeBytes: free,
          freePercent: total > 0 ? Number((100 * free / total).toFixed(2)) : 0
        },
        network,
        notes: [
          sampleMs > 0 ? 'CPU usage sampled from os.cpus() times.' : 'CPU usage omitted (set sampleMs 100-5000).',
          'rx/tx traffic bytes are not available from Node built-ins; networkInterfaces() lists addresses/MAC only.'
        ]
      }
    }
  }
}

// ---------------------------------------------------------------------------
// tool 2: encoding_run
// ---------------------------------------------------------------------------

function encodingRunTool() {
  return {
    name: 'encoding_run',
    description: 'Run a shell command and capture stdout/stderr as RAW BYTES, then auto-detect the text encoding (UTF-8 BOM, UTF-16LE/BE, pure ASCII, strict UTF-8, GBK, GB18030, Latin-1) and decode correctly. Use this instead of the built-in bash tool when a command may emit Chinese GBK/UTF-16LE output that would otherwise become garbled. NOTE: this tool spawns its own process; it does NOT inherit the built-in bash sandbox, approval or background-task features, and runs with the same privileges as DSH itself.',
    parameters: obj({
      command: str('The command string to execute.'),
      shell: str('Executable to run the command. Default: bash on POSIX, cmd.exe on Windows.'),
      cwd: str('Working directory. Omit to use the current DSH working directory.'),
      encoding: str('Force a specific encoding (e.g. utf-8, utf-16le, gbk, gb18030). Omit to auto-detect.'),
      timeoutMs: int('Kill the process after this many milliseconds. Default 30000.'),
      maxBytes: int('Max bytes captured per stream before truncation. Default 8388608 (8 MiB).')
    }, ['command']),
    output: {
      schema: obj({
        command: { type: 'string' }, shell: { type: 'string' }, exitCode: { type: 'number' },
        stdout: { type: 'string' }, stderr: { type: 'string' },
        stdoutEncoding: { type: 'string' }, stderrEncoding: { type: 'string' },
        stdoutConfidence: { type: 'string' }, stderrConfidence: { type: 'string' },
        truncated: { type: 'boolean' }, timedOut: { type: 'boolean' }
      }, ['command', 'shell', 'exitCode', 'stdout', 'stderr', 'stdoutEncoding', 'stderrEncoding', 'stdoutConfidence', 'stderrConfidence', 'truncated', 'timedOut']),
      render: renderJson
    },
    async execute(args, exec) {
      const command = args && args.command
      if (typeof command !== 'string' || command.length === 0) throw new Error('command is required')
      let timeoutMs = args.timeoutMs === undefined ? 30000 : args.timeoutMs
      let maxBytes = args.maxBytes === undefined ? 8 * 1024 * 1024 : args.maxBytes
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('timeoutMs must be 1..600000')
      if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 64 * 1024 * 1024) throw new Error('maxBytes must be 1024..67108864')
      const shell = args.shell || (process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'bash')
      const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c'] : ['-c']
      const child = spawn(shell, [...shellArgs, command], {
        cwd: args.cwd || undefined,
        windowsHide: true,
        env: process.env
      })
      const outChunks = []
      const errChunks = []
      let outLen = 0
      let errLen = 0
      let truncated = false
      let timedOut = false
      const collect = (chunks, add) => (chunk) => {
        const next = add(chunk.length)
        if (next > maxBytes) { truncated = true; return }
        chunks.push(chunk)
      }
      if (child.stdout) child.stdout.on('data', collect(outChunks, n => (outLen += n)))
      if (child.stderr) child.stderr.on('data', collect(errChunks, n => (errLen += n)))
      const timer = setTimeout(() => { timedOut = true; try { child.kill() } catch (_) {} }, timeoutMs)
      const signal = exec && exec.signal
      const onAbort = () => { try { child.kill() } catch (_) {} }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      const exitCode = await new Promise((resolve) => {
        child.on('close', code => resolve(typeof code === 'number' ? code : -1))
        child.on('error', () => resolve(-1))
      })
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      const out = decodeBytes(Buffer.concat(outChunks), args.encoding)
      const err = decodeBytes(Buffer.concat(errChunks), args.encoding)
      return {
        command,
        shell,
        exitCode,
        stdout: out.text,
        stderr: err.text,
        stdoutEncoding: out.encoding,
        stderrEncoding: err.encoding,
        stdoutConfidence: out.confidence,
        stderrConfidence: err.confidence,
        truncated,
        timedOut
      }
    }
  }
}

// ---------------------------------------------------------------------------
// tool 3: token cost estimation
// ---------------------------------------------------------------------------

async function readTextSafe(_fs, filePath, _signal) {
  // Tools run in the host Node process; these are ordinary disk files. Read
  // them with node:fs directly instead of DSH's fs service (which is not
  // reachable from this plugin's inject scope).
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (_) { return null }
}

function findInstructionFiles(_fs, cwd, _signal) {
  const files = []
  const home = os.homedir()
  const roots = [home, path.join(home, '.dsh')]
  let dir = path.resolve(cwd || process.cwd())
  for (let i = 0; i < 12; i++) {
    roots.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const seen = new Set()
  for (const root of roots) {
    for (const name of ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']) {
      const p = path.join(root, name)
      if (seen.has(p)) continue
      seen.add(p)
      files.push(p)
    }
  }
  return files
}

function tokenCostTool() {
  return {
    name: 'token_cost',
    description: 'Estimate the token cost (using DSH core tokenMeter density heuristic, ceil(chars/4)+4) of context-fixed overhead: tool schemas visible to this agent, skill catalog summaries + full skill bodies, and AGENTS.md/CLAUDE.md instruction-chain files discovered from the working directory chain. Estimates only — not exact provider billing. Skill bodies and AGENTS.md are only fully injected in certain paths; the report marks which are always-on vs on-demand.',
    parameters: obj({
      cwd: str('Working directory to scan for AGENTS.md/CLAUDE.md. Defaults to the process working directory.'),
      includeSkillBodies: bool('Also load and estimate each skill SKILL.md full body. Default false (bodies are on-demand in DSH).')
    }),
    output: {
      schema: obj({
        method: { type: 'string' },
        toolSchemas: obj({
          count: { type: 'integer' }, tokens: { type: 'integer' }, alwaysOn: { type: 'boolean' }
        }, ['count', 'tokens', 'alwaysOn']),
        skills: obj({
          summaryCount: { type: 'integer' }, summaryTokens: { type: 'integer' },
          bodyCount: { type: 'number' }, bodyTokens: { type: 'number' }, bodiesIncluded: { type: 'boolean' }
        }, ['summaryCount', 'summaryTokens', 'bodyCount', 'bodyTokens', 'bodiesIncluded']),
        instructions: obj({
          fileCount: { type: 'integer' }, tokens: { type: 'integer' },
          files: arr(obj({ path: { type: 'string' }, chars: { type: 'integer' }, tokens: { type: 'integer' } }, ['path', 'chars', 'tokens']))
        }, ['fileCount', 'tokens', 'files']),
        totalAlwaysOnTokens: { type: 'integer' },
        notes: arr({ type: 'string' })
      }, ['method', 'toolSchemas', 'skills', 'instructions', 'totalAlwaysOnTokens', 'notes']),
      render: renderJson
    },
    async execute(args, ctx) {
      const cwd = (args && args.cwd) || process.cwd()
      const signal = ctx && ctx.signal
      const agent = ctx && ctx.agent
      // tool schemas
      let schemas = []
      try { if (ctx && typeof ctx.toolsSchemas === 'function') schemas = ctx.toolsSchemas(agent) } catch (_) { schemas = [] }
      const schemaTokens = schemas.length ? est(json(schemas)) : 0
      // skills
      let summaries = []
      let bodyChars = 0
      let bodyCount = 0
      const includeBodies = !!(args && args.includeSkillBodies)
      try {
        if (ctx && typeof ctx.skillList === 'function') {
          summaries = await ctx.skillList({ cwd, scope: agent, signal }) || []
          if (includeBodies && typeof ctx.skillGet === 'function') {
            for (const s of summaries) {
              try {
                const full = await ctx.skillGet(s.name, { cwd, scope: agent, signal })
                const content = full && (full.content !== undefined ? full.content : (full.body || ''))
                if (content) { bodyChars += String(content).length; bodyCount++ }
              } catch (_) {}
            }
          }
        }
      } catch (_) { summaries = [] }
      const summaryTokens = summaries.length ? est(json(summaries)) : 0
      const bodyTokens = includeBodies ? est(bodyChars + '  x'.repeat(bodyCount)) : 0
      // instruction files
      const infos = []
      for (const p of findInstructionFiles(ctx && ctx.fs, cwd, signal)) {
        const text = await readTextSafe(ctx && ctx.fs, p, signal)
        if (text == null) continue
        // account for the <system-reminder> wrapper DSH adds (pass a STRING,
        // not a number: est() measures String(x).length, so a number would be
        // measured by its digit count)
        const wrapped = text + ' '.repeat(60)
        infos.push({ path: p, chars: text.length, tokens: est(wrapped) })
      }
      const instructionTokens = infos.reduce((s, f) => s + f.tokens, 0)
      const alwaysOn = schemaTokens + summaryTokens + instructionTokens
      return {
        method: 'density estimate ceil(chars/4)+4, same heuristic as @deepseek-ai/dsh-token-meter estimateMessage',
        toolSchemas: { count: schemas.length, tokens: schemaTokens, alwaysOn: true },
        skills: {
          summaryCount: summaries.length, summaryTokens,
          bodyCount: includeBodies ? bodyCount : summaries.length,
          bodyTokens, bodiesIncluded: includeBodies
        },
        instructions: { fileCount: infos.length, tokens: instructionTokens, files: infos },
        totalAlwaysOnTokens: alwaysOn,
        notes: [
          'Tool schemas and skill catalog summaries are injected every request.',
          'Full skill bodies enter context only when the skill tool or /name is used (set includeSkillBodies to estimate that worst case).',
          'AGENTS.md is injected as a user-role <system-reminder>; per-file injected chars depend on dedup/budget, so these are upper-bound estimates.',
          'This is a heuristic, not exact provider billing; no per-category exact billing API exists in DSH.'
        ]
      }
    }
  }
}

// ---------------------------------------------------------------------------
// tool 4: conflict / duplicate inspection
// ---------------------------------------------------------------------------

function conflictCheckTool() {
  return {
    name: 'config_conflicts',
    description: 'Inspect the DSH configuration for duplicates and collisions: identical AGENTS.md/CLAUDE.md instruction files, identical or near-duplicate instruction paragraphs across the discovery chain, skills with the same name from different scopes (DSH silently keeps the nearest layer), and tool name collisions. DSH core has no semantic conflict detection, so this reports structural duplicates only. Read-only.',
    parameters: obj({
      cwd: str('Working directory to scan. Defaults to the process working directory.')
    }),
    output: {
      schema: obj({
        duplicateInstructionFiles: arr(obj({
          a: { type: 'string' }, b: { type: 'string' }, shaLike: { type: 'string' }
        }, ['a', 'b', 'shaLike'])),
        duplicateParagraphs: arr(obj({
          text: { type: 'string' }, files: arr({ type: 'string' })
        }, ['text', 'files'])),
        duplicateSkillNames: arr(obj({
          name: { type: 'string' }, count: { type: 'integer' }, scopes: arr({ type: 'string' })
        }, ['name', 'count', 'scopes'])),
        toolNameCollisions: arr({ type: 'string' }),
        summary: { type: 'string' }
      }, ['duplicateInstructionFiles', 'duplicateParagraphs', 'duplicateSkillNames', 'toolNameCollisions', 'summary']),
      render: renderJson
    },
    async execute(args, ctx) {
      const cwd = (args && args.cwd) || process.cwd()
      const signal = ctx && ctx.signal
      const agent = ctx && ctx.agent
      // duplicate instruction files (identical trimmed content)
      const byContent = new Map()
      const dupFiles = []
      const paraMap = new Map()
      for (const p of findInstructionFiles(ctx && ctx.fs, cwd, signal)) {
        const text = await readTextSafe(ctx && ctx.fs, p, signal)
        if (text == null) continue
        const trimmed = text.trim()
        if (trimmed) {
          if (byContent.has(trimmed)) {
            dupFiles.push({ a: byContent.get(trimmed), b: p, shaLike: 'identical trimmed content' })
          } else byContent.set(trimmed, p)
        }
        // paragraph-level duplicates (non-trivial lines)
        const seenInFile = new Set()
        for (const raw of text.split(/\r?\n/)) {
          const line = raw.trim()
          if (line.length < 12 || line.startsWith('#') || seenInFile.has(line)) continue
          seenInFile.add(line)
          if (!paraMap.has(line)) paraMap.set(line, new Set())
          paraMap.get(line).add(p)
        }
      }
      const dupParas = []
      for (const [text, files] of paraMap) {
        if (files.size > 1) dupParas.push({ text: text.slice(0, 200), files: [...files] })
      }
      // duplicate skill names across scopes
      const skillMap = new Map()
      try {
        if (ctx && typeof ctx.skillList === 'function') {
          const list = await ctx.skillList({ cwd, scope: agent, signal }) || []
          for (const s of list) {
            const name = s.name || s.id
            if (!name) continue
            if (!skillMap.has(name)) skillMap.set(name, { count: 0, scopes: new Set() })
            const e = skillMap.get(name)
            e.count++
            e.scopes.add(s.scope || s.source || 'unknown')
          }
        }
      } catch (_) {}
      const dupSkills = []
      for (const [name, e] of skillMap) {
        if (e.count > 1) dupSkills.push({ name, count: e.count, scopes: [...e.scopes] })
      }
      // tool name collisions (global registry disallows them, but report a view count)
      const collisions = []
      try {
        if (ctx && typeof ctx.toolsSchemas === 'function') {
          const schemas = ctx.toolsSchemas(agent) || []
          const seen = new Set()
          for (const s of schemas) {
            if (seen.has(s.name)) collisions.push(s.name)
            seen.add(s.name)
          }
        }
      } catch (_) {}
      const total = dupFiles.length + dupParas.length + dupSkills.length + collisions.length
      return {
        duplicateInstructionFiles: dupFiles,
        duplicateParagraphs: dupParas.slice(0, 50),
        duplicateSkillNames: dupSkills,
        toolNameCollisions: collisions,
        summary: total === 0
          ? 'No structural duplicates found.'
          : `Found ${dupFiles.length} duplicate file(s), ${dupParas.length} duplicate paragraph(s), ${dupSkills.length} duplicate skill name(s), ${collisions.length} tool collision(s).`
      }
    }
  }
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

/**
 * Register all host tools. Returns a single disposer that unregisters them all.
 * ctx is the host plugin context; we stash a few service calls onto the tool's
 * execution context so the tool bodies stay decoupled from service names.
 */
export function registerAllTools(ctx, isEnabled) {
  const disposers = []
  const allows = (name) => !isEnabled || typeof isEnabled[name] !== 'function' || isEnabled[name]() !== false

  // Build a tool-exec adapter exposing only what the tools need.
  // IMPORTANT: use ctx.get(name) (explicit service lookup, no inject needed)
  // and defer every access to call time. Reading ctx.<service> as a property
  // requires that service in `inject`, and throws "cannot get property X
  // without inject" otherwise — which would break even tools that never use it.
  const safeGet = (name) => { try { return ctx.get(name) } catch (_) { return undefined } }
  const adapterFor = (base) => {
    const exec = base || {}
    return {
      get signal() { return exec.signal },
      get agent() { return exec.agent },
      toolsSchemas: (agent) => {
        const tools = safeGet('tools')
        if (!tools || typeof tools.schemas !== 'function') return []
        return tools.schemas(agent) || []
      },
      skillList: (opts) => {
        const skills = safeGet('skills')
        if (!skills || typeof skills.list !== 'function') return []
        return skills.list(opts)
      },
      skillGet: (name, opts) => {
        const skills = safeGet('skills')
        if (!skills || typeof skills.get !== 'function') throw new Error('skills.get unavailable')
        return skills.get(name, opts)
      },
      get fs() { return safeGet('fs') }
    }
  }

  // Volatile config updates in place and does NOT re-run apply(), so the
  // enabled decision must be made at execute time, not register time.
  const wrap = (tool) => ({
    ...tool,
    async execute(args, exec) {
      if (!allows(tool.name)) {
        throw new Error('[dsh-toolbox-gjkt] tool "' + tool.name + '" is turned off in 设置 → 工具箱. Enable it there first.')
      }
      return tool.execute(args, adapterFor(exec))
    }
  })

  const tools = [sysinfoTool(), encodingRunTool(), tokenCostTool(), conflictCheckTool()]
  for (const tool of tools) {
    try {
      const d = ctx.tools.register(wrap(tool))
      if (d && typeof d === 'function') disposers.push(d)
      else if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose())
    } catch (e) {
      // Do not let one tool registration break the whole bundle.
      try { console.error('[dsh-toolbox-gjkt] failed to register tool', tool.name, e && e.message) } catch (_) {}
    }
  }
  return () => {
    for (const d of disposers) {
      try { d() } catch (_) {}
    }
  }
}
