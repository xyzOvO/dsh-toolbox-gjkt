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
 */
import z from '@deepseek-ai/schemastery'
import { registerAllTools } from './tools.js'

export const Config = z.object({
  // master switches — one per tool, so any tool can be disabled to avoid conflicts
  notifyOn: z.boolean().default(true).volatile(),
  toolbarOn: z.boolean().default(true).volatile(),
  autoWakeOn: z.boolean().default(false).volatile(),
  // task notifications
  mode: z.union(['background', 'always', 'never']).default('background').volatile(),
  subagent: z.boolean().default(false).volatile(),
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
})

// Services used by the host half.
export const inject = ['tools']

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
  return registerAllTools(ctx, isEnabled)
}
