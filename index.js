/**
 * Host half of dsh-toolbox-gjkt.
 *
 * Runtime work is done by the Client half: DSH core already forwards session
 * lifecycle events to the browser, so no Host RPC is needed here. This half
 * only declares the user-facing Config schema shown on the 工具箱 settings page.
 * Every field is `.volatile()` so edits apply in place without a restart.
 *
 * Host agent tools (sysinfo / encoding_run / token_cost / config_conflicts)
 * are registered from ./tools.js. schemastery is a declared dependency so the
 * package installs and resolves normally on any machine.
 *
 * The citation rule is injected as a system-prompt section so it is present on
 * every model step without relying on the model to go read a rules file.
 */
import z from '@deepseek-ai/schemastery'
import { registerAllTools } from './tools.js'

// Citation instruction injected into the system prompt. Text is a function of
// live volatile config, so toggling the switch or format applies immediately.
const CITE_SHARED = [
  'When a factual claim comes from a source you actually retrieved, append one clickable citation immediately after the claim.',
  'Web source: write the full URL. Local note: write the absolute path with forward slashes (e.g. D:/path/to/note.md) and only after confirming the file exists via a search — never invent a path from memory.',
  'Do not cite generic knowledge, reasoning, or your own inference — cite only facts with a concrete source. If no source is verified, add nothing rather than fabricate.',
  'Do not put citations inside code blocks or tables. In this environment Markdown footnotes ([^1]) and inline HTML <details> render as plain text and are not clickable — never use them; use a Markdown link only.',
].join(' ')

const CITE_INSTRUCTIONS = {
  superscript: CITE_SHARED + ' Format: a superscript numeral in a Markdown link, e.g. [¹](source). Superscript digits: ¹²³⁴⁵⁶⁷⁸⁹⁰; once you exceed nine distinct sources in one answer, fall back to plain [1](source), [2](source) for all.',
  numeric: CITE_SHARED + ' Format: a plain numeral in a Markdown link, e.g. [1](source), [2](source).',
  text: CITE_SHARED + ' Format: a short label in a Markdown link, e.g. [来源](source). Use a concise source label (site or file name), not a raw URL as the visible text.',
}

export const Config = z.object({
  // master switches — one per tool, so any tool can be disabled to avoid conflicts
  notifyOn: z.boolean().default(true).volatile(),
  toolbarOn: z.boolean().default(true).volatile(),
  autoWakeOn: z.boolean().default(false).volatile(),
  // task notifications
  mode: z.union(['background', 'always', 'never']).default('background').volatile(),
  subagent: z.boolean().default(false).volatile(),
  chime: z.union(['dual', 'single', 'triple', 'off']).default('dual').volatile(),
  // selection toolbar
  search: z.boolean().default(true).volatile(),
  translate: z.boolean().default(true).volatile(),
  copy: z.boolean().default(true).volatile(),
  ask: z.boolean().default(true).volatile(),
  searchEngine: z.union(['bing', 'baidu', 'google']).default('bing').volatile(),
  translateDir: z.union(['auto', 'zh2en', 'en2zh']).default('auto').volatile(),
  // master switches for the four host tools (live via .get(), no restart)
  sysinfoOn: z.boolean().default(true).volatile(),
  encodingOn: z.boolean().default(true).volatile(),
  tokenCostOn: z.boolean().default(true).volatile(),
  conflictsOn: z.boolean().default(true).volatile(),
  // citation corner marks (system-prompt injection, off by default)
  citeOn: z.boolean().default(false).volatile(),
  citeFormat: z.union(['superscript', 'numeric', 'text']).default('superscript').volatile(),
})

// Services used by the host half.
export const inject = ['tools', 'systemPrompt']

export function apply(ctx, config) {
  // Volatile config fields are read live via .get(), so toggling a switch in
  // settings takes effect on the next tool call without a restart.
  const enabled = (field, fallback) => {
    const f = config && config[field]
    if (!f || typeof f.get !== 'function') return fallback
    try { return f.get() !== false } catch (_) { return fallback }
  }
  const isEnabled = {
    sysinfo: () => enabled('sysinfoOn', true),
    encoding_run: () => enabled('encodingOn', true),
    token_cost: () => enabled('tokenCostOn', true),
    config_conflicts: () => enabled('conflictsOn', true),
  }
  const disposeTools = registerAllTools(ctx, isEnabled)

  // Read citation config live on every model step (volatile fields update in
  // place), so no restart is needed after toggling the switch or format.
  const citeText = () => {
    if (!enabled('citeOn', false)) return ''
    const raw = config && config.citeFormat && typeof config.citeFormat.get === 'function'
      ? config.citeFormat.get() : 'superscript'
    return CITE_INSTRUCTIONS[raw] || CITE_INSTRUCTIONS.superscript
  }
  const disposeCite = ctx.effect(() => ctx.systemPrompt.section({
    name: 'toolbox:fact-citations',
    order: 4400,
    text: () => citeText(),
    interpolate: false,
  }), 'toolbox.citations.section()')

  return () => { disposeCite?.(); disposeTools?.() }
}
