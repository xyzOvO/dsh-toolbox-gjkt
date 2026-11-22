/**
 * Client half of dsh-toolbox-gjkt.
 *
 * Two features in one settings section (工具箱):
 *  - Task notifications: DSH core forwards session lifecycle events to the
 *    browser over ctx.remote.$on('api-session/*'); OS popup via the browser
 *    Notification API; chime via Web Audio. No Host RPC, no polling.
 *  - Selection toolbar: floating search / translate / copy / ask-agent on
 *    right-click (primary) or ordinary selection where core quote declines.
 *
 * ALL controls live on the 工具箱 settings page (settings.section). Nothing is
 * added to the composer. Settings are read/written through ctx.configForms.
 */
window.__ModuleLoader__.load({
  id: 'dsh-toolbox-gjkt',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React

    // =====================================================================
    // notification helpers
    // =====================================================================
    let audioCtx = null
    function unlockAudio() {
      if (audioCtx) return
      const AC = window.AudioContext || window.webkitAudioContext
      if (!AC) return
      try { audioCtx = new AC() } catch (_) { audioCtx = null }
    }
    function playChime() {
      if (!audioCtx) return
      try {
        if (audioCtx.state === 'suspended') audioCtx.resume()
        const now = audioCtx.currentTime
        ;[880, 1174.66].forEach((freq, i) => {
          const osc = audioCtx.createOscillator()
          const gain = audioCtx.createGain()
          osc.type = 'sine'
          osc.frequency.value = freq
          const t = now + i * 0.16
          gain.gain.setValueAtTime(0.0001, t)
          gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02)
          gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28)
          osc.connect(gain).connect(audioCtx.destination)
          osc.start(t)
          osc.stop(t + 0.3)
        })
      } catch (_) { /* best effort */ }
    }
    function isBackgrounded() {
      if (typeof document === 'undefined') return true
      try { return document.hidden === true || document.hasFocus() === false } catch (_) { return true }
    }
    function fireNotification(title, body) {
      playChime()
      if (typeof window.Notification === 'undefined') return 'no-Notification-API'
      if (window.Notification.permission !== 'granted') return 'perm=' + window.Notification.permission
      try {
        const n = new window.Notification(title, { body })
        setTimeout(() => { try { n.close() } catch (_) {} }, 12000)
        return 'sent'
      } catch (e) {
        return 'throw:' + (e && e.message ? e.message : String(e))
      }
    }
    function testNotification() {
      unlockAudio()
      if (typeof window.Notification !== 'undefined' && window.Notification.permission === 'default') {
        try { window.Notification.requestPermission() } catch (_) {}
      }
      return fireNotification(tv('testTitle'), tv('testBody'))
    }
    function titleOf(sessionId, ctx) {
      const sessions = ctx.get('sessions')
      try {
        const byId = sessions && sessions.list && sessions.list.getSnapshot().byId
        const row = byId && byId[sessionId]
        if (row && row.displayTitle) return row.displayTitle
      } catch (_) {}
      return String(sessionId)
    }

    const subagentIds = new Set()
    function markSubagent(summary) {
      if (!summary) return
      const id = summary.id || summary.sessionId
      if (!id) return
      if (summary.origin === 'subagent' || summary.parentId || summary.parentSessionId) subagentIds.add(id)
    }
    function autoNotify(sessionId, title, body, settings) {
      const mode = settings && settings.mode ? settings.mode : 'background'
      const subagentOn = !!(settings && settings.subagent)
      if (mode === 'never') return 'disabled'
      if (subagentIds.has(sessionId) && !subagentOn) return 'subagent-off'
      if (mode === 'always') return fireNotification(title, body)
      if (!isBackgrounded()) return 'foreground'
      return fireNotification(title, body)
    }

    // =====================================================================
    // selection toolbar helpers
    // =====================================================================
    const hasCJK = (s) => /[\u3400-\u9fff]/.test(s)
    const SEARCH_ENGINES = {
      bing: { label: 'Bing', url: (q) => 'https://www.bing.com/search?q=' + encodeURIComponent(q) },
      baidu: { label: '百度', url: (q) => 'https://www.baidu.com/s?wd=' + encodeURIComponent(q) },
      google: { label: 'Google', url: (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q) },
    }
    const ENGINE_KEYS = ['bing', 'baidu', 'google']
    const DIR_KEYS = ['auto', 'zh2en', 'en2zh']
    const DIRS = { auto: '自动检测', zh2en: '中→英', en2zh: '英→中' }
    function normalizeToolbar(v) {
      const s = v || {}
      const engine = ENGINE_KEYS.indexOf(s.searchEngine) >= 0 ? s.searchEngine : 'bing'
      const dir = DIR_KEYS.indexOf(s.translateDir) >= 0 ? s.translateDir : 'auto'
      return {
        search: s.search !== false,
        translate: s.translate !== false,
        copy: s.copy !== false,
        ask: s.ask !== false,
        searchEngine: engine,
        translateDir: dir,
      }
    }

    function wakeKey(id, st) {
      const parts = [...st.artifacts].sort().concat([...st.workflows].sort().map((w) => 'wf:' + w))
      const s = parts.join('|')
      let hash = 0
      for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0
      return 'aw:' + id + ':' + (hash >>> 0).toString(36)
    }

    // Send a request to the main-view session so the agent runs the named tool
    // and reports the result in that conversation. Mirrors DSH's own main-session
    // lookup (dsh-client-ui-session publishMain): retainedBy.mainView > 0.
    function runTool(msgKey, ctx, form) {
      try {
        let remote = null
        try { remote = (ctx.get && ctx.get('remote')) || null } catch (_) {}
        let sessRemote = null
        try { sessRemote = (ctx.get && ctx.get('remote.session')) || null } catch (_) {}
        if (!sessRemote) sessRemote = (ctx.remote && ctx.remote.session) || (remote && remote.session) || null
        if (!sessRemote || typeof sessRemote.prompt !== 'function') return 'noRemote'
        const sessions = ctx.get('sessions')
        const byId = sessions && sessions.list && sessions.list.getSnapshot().byId
        let sessionId
        if (byId) {
          for (const row of Object.values(byId)) {
            if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) { sessionId = row.id; break }
          }
        }
        if (!sessionId) return 'noSession'
        const requestId = 'tb:' + Date.now() + ':' + Math.floor(Math.random() * 1e6)
        let clientTimeZone
        try { clientTimeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone } catch (_) {}
        const request = {
          requestId, sessionId, mode: 'queue',
          content: [{ type: 'text', text: tv(msgKey) }],
        }
        if (clientTimeZone) request.clientTimeZone = clientTimeZone
        const res = sessRemote.prompt(request)
        Promise.resolve(res).then((r) => {
          if (r && r.ok === false) console.warn('[dsh-toolbox-gjkt] runTool rejected', r)
        }).catch((e) => console.warn('[dsh-toolbox-gjkt] runTool failed', e))
        return 'ok'
      } catch (e) {
        console.warn('[dsh-toolbox-gjkt] runTool error', e)
        return 'noRemote'
      }
    }

    // =====================================================================
    // settings section (工具箱)
    // =====================================================================
    const ENTRY_ID = 'toolbox'                       // configForms namespace = cordis.patch row id
    const LOCALE = 'toolbox.settings'
    const MODE_KEYS = ['background', 'always', 'never']

    const en = {
      nav: 'Toolbox',
      // master switches
      masterTitle: 'Master switches',
      masterDesc: 'Turn any tool off here if it conflicts with another plugin.',
      notifyOn: 'Task notifications', toolbarOn: 'Selection toolbar',
      autoWakeOn: 'Auto-continue',
      sysinfoOn: 'System info tool', encodingOn: 'Encoding-safe shell',
      tokenCostOn: 'Token cost tool', conflictsOn: 'Conflict checker',
      notifyTitle: 'Task notifications',
      notifyDesc: 'System notification and chime when a background task finishes.',
      mode: 'When to notify',
      background: 'Background only', always: 'Always', never: 'Never',
      subagent: 'Also notify when a subagent finishes',
      autoWake: 'Auto-continue after completion',
      autoWakeDesc: 'When a task produces an artifact or ends a workflow, append a message to continue it. Appears as a user bubble; needs this window open.',
      test: 'Send test notification', sent: 'Sent', failed: 'Not sent',
      toolbarTitle: 'Selection toolbar',
      toolbarDesc: 'Right-click selected chat text for search, translate, copy and ask-agent actions.',
      buttons: 'Visible buttons',
      search: 'Search', translate: 'Translate', copy: 'Copy', ask: 'Ask agent',
      searchEngine: 'Search engine', translateDir: 'Translate direction',
      // runtime notifications
      testTitle: 'DSH task notification (test)',
      testBody: 'If you can see this in the notification bar, system notifications work.',
      taskDone: 'Task finished', taskDoneSuffix: ' finished',
      taskError: 'Task error', errorSuffix: ': ',
      artifactNotice: 'Artifacts', workflowNotice: 'Workflow',
      wf_completed: 'completed', wf_cancelled: 'cancelled', wf_error: 'error',
      autoWakeMsg: '【Auto-continue】The previous step finished. Please check the result and continue.',
      // toolbar actions / hints
      askPrompt: 'Please help me with the text below:\n\n',
      copied: 'Copied', clipboardUnavailable: 'Clipboard unavailable', copyFailed: 'Copy failed',
      asked: 'Filled into input', askFailed: 'Cannot fill input',
      searchTitle: 'Search selected text with {engine}',
      translateTitle: 'Translate selected text with Baidu',
      copyTitle: 'Copy selected text', askTitle: 'Fill selected text into the input',
      // host tools (run in the current conversation)
      toolsTitle: 'Tools',
      toolsDesc: 'These run as agent tools. Tap Run to send a request to the current chat; the result appears in that conversation.',
      run: 'Run', submitted: 'Sent to current chat', noSession: 'Open a chat first',
      noRemote: 'Remote unavailable', runDisabled: 'This tool is turned off in Master switches',
      run_sysinfo: 'Use the sysinfo tool to report this machine OS, CPU, memory and network.',
      run_encoding_run: 'Use the encoding_run tool to run a short command that prints Chinese text, and show the decoded output.',
      run_token_cost: 'Use the token_cost tool to report instruction, skill and tool-schema token costs.',
      run_config_conflicts: 'Use the config_conflicts tool to check for duplicate instructions, skills and conflicts.',
      desc_sysinfo: 'What the machine is: system, CPU, memory, network cards.',
      desc_encoding_run: 'Run a command and decode garbled Chinese back to readable text.',
      desc_token_cost: 'See how many tokens instructions, skills and tool schemas eat.',
      desc_config_conflicts: 'Find duplicated instructions, same-named skills or tools.',
    }
    const zh = {
      nav: '工具箱',
      // master switches
      masterTitle: '总开关',
      masterDesc: '某个工具和别的插件冲突时，可以在这里单独关掉它。',
      notifyOn: '任务通知', toolbarOn: '划词工具栏',
      autoWakeOn: '自动续作',
      sysinfoOn: '系统信息工具', encodingOn: '编码安全 Shell',
      tokenCostOn: 'Token 成本工具', conflictsOn: '冲突检查工具',
      notifyTitle: '任务通知',
      notifyDesc: '后台任务完成时弹出系统通知并播放提示音。',
      mode: '通知模式',
      background: '仅后台', always: '始终', never: '从不',
      subagent: '子代理完成也通知',
      autoWake: '完成后自动续作',
      autoWakeDesc: '任务产出文件或工作流结束时，自动追加一条消息让它继续。会显示一条用户气泡，且需要本窗口保持打开。',
      test: '测试通知', sent: '已发送', failed: '未发送',
      toolbarTitle: '划词工具栏',
      toolbarDesc: '右键选中聊天文字，弹出搜索、翻译、复制、问 agent 工具栏。',
      buttons: '显示的按钮',
      search: '搜索', translate: '翻译', copy: '复制', ask: '问 agent',
      searchEngine: '搜索引擎', translateDir: '翻译方向',
      // runtime notifications
      testTitle: 'DSH 任务通知（测试）',
      testBody: '如果你在通知栏看到这条，说明系统级通知可用。',
      taskDone: '任务完成', taskDoneSuffix: ' 已完成',
      taskError: '任务出错', errorSuffix: '：',
      artifactNotice: '产物', workflowNotice: '工作流',
      wf_completed: '完成', wf_cancelled: '取消', wf_error: '出错',
      autoWakeMsg: '【自动续作】上一步已完成，请检查结果并继续。',
      // toolbar actions / hints
      askPrompt: '请就下面这段内容帮我处理：\n\n',
      copied: '已复制', clipboardUnavailable: '剪贴板不可用', copyFailed: '复制失败',
      asked: '已填入输入框', askFailed: '无法填入输入框',
      searchTitle: '用{engine}搜索选中文字',
      translateTitle: '用百度翻译选中文字',
      copyTitle: '复制选中文字', askTitle: '把选中文字填入输入框',
      // host 工具（在当前对话里运行）
      toolsTitle: '工具',
      toolsDesc: '这些是 agent 工具。点「运行」会把请求发到当前对话，结果在那个会话里查看。',
      run: '运行', submitted: '已发到当前对话', noSession: '请先打开一个会话',
      noRemote: '远程服务不可用', runDisabled: '该工具已在总开关里关闭',
      run_sysinfo: '请用 sysinfo 工具汇报这台机器的系统、CPU、内存和网络信息。',
      run_encoding_run: '请用 encoding_run 工具运行一条会输出中文的短命令，并展示解码后的结果。',
      run_token_cost: '请用 token_cost 工具统计指令、Skill 和工具 Schema 的 token 开销。',
      run_config_conflicts: '请用 config_conflicts 工具检查重复的指令、同名 Skill 和冲突。',
      desc_sysinfo: '看这台机器是啥配置：系统、CPU、内存、网卡。',
      desc_encoding_run: '跑一条命令，把乱码中文变回能看的字。',
      desc_token_cost: '看指令、Skill、工具说明各吃了多少 token。',
      desc_config_conflicts: '查出重复的指令、重名的 Skill 和工具。',
    }

    // factory-level translator for runtime notifications / toolbar (no React hook here)
    let tr = (k) => String(k)
    const tv = (k, vars) => {
      let s = tr(k)
      if (vars) for (const name of Object.keys(vars)) s = s.split('{' + name + '}').join(vars[name])
      return s
    }

    const controlStyle = {
      fontSize: 13, padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
      border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.18))',
      background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,.05))',
      color: 'var(--dsw-alias-label-primary, #1a1a1a)',
    }
    function row(label, node) {
      return h('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '7px 0' }
      }, h('span', null, label), node)
    }

    function ToolboxSection({ useForm, setMode, setSubagent, setValue, testNotify, runTool, t }) {
      // Defensive: a missing injected hook must disable controls, never blank the page.
      const tr = typeof t === 'function' ? t : (k) => String(k)
      const snap = typeof useForm === 'function' ? useForm((s) => s) : null
      const value = (snap && snap.value) || {}
      const writable = !!(snap && snap.status === 'ready' && snap.writable)
      const [hint, setHint] = useState('')
      t = tr // use the guarded translator for every t() call below

      const mode = MODE_KEYS.indexOf(value.mode) >= 0 ? value.mode : 'background'
      const subagent = value.subagent === true
      const tb = normalizeToolbar(value)
      const on = (key, dflt) => (typeof value[key] === 'boolean' ? value[key] : dflt)

      const onTest = () => {
        const r = testNotify()
        setHint(r === 'sent' ? t('sent') : t('failed') + ' (' + r + ')')
        setTimeout(() => setHint(''), r === 'sent' ? 2000 : 6000)
      }
      const onRun = (toolKey) => {
        if (typeof runTool !== 'function') { setHint(t('noRemote')); setTimeout(() => setHint(''), 5000); return }
        const r = runTool(toolKey)
        const msg = r === 'ok' ? t('submitted') : r === 'off' ? t('runDisabled') : t(r) || String(r)
        setHint(msg)
        setTimeout(() => setHint(''), 3000)
      }
      const TOOL_RUNS = [
        { key: 'sysinfoOn', msg: 'run_sysinfo', desc: 'desc_sysinfo' },
        { key: 'encodingOn', msg: 'run_encoding_run', desc: 'desc_encoding_run' },
        { key: 'tokenCostOn', msg: 'run_token_cost', desc: 'desc_token_cost' },
        { key: 'conflictsOn', msg: 'run_config_conflicts', desc: 'desc_config_conflicts' },
      ]
      const [collapsed, setCollapsed] = useState({ master: true, notify: true, toolbar: true, tools: true })
      // Styled sliding switch (button with role=switch) instead of a native checkbox.
      const Switch = ({ checked, disabled, onChange, label }) => h('button', {
        type: 'button', role: 'switch', 'aria-checked': !!checked, 'aria-label': label,
        disabled: !!disabled,
        onClick: () => { if (!disabled) onChange(!checked) },
        style: {
          position: 'relative', flex: 'none', width: 38, height: 22, padding: 0,
          borderRadius: 11, cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? .5 : 1, transition: 'background .18s, border-color .18s',
          border: '1px solid ' + (checked ? 'var(--dsw-alias-brand-primary, #3f7fbf)' : 'var(--dsw-alias-border-l2, rgba(0,0,0,.2))'),
          background: checked ? 'var(--dsw-alias-brand-primary, #3f7fbf)' : 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,.12))',
        },
      }, h('span', {
        style: {
          position: 'absolute', top: 2, left: checked ? 19 : 2, width: 16, height: 16,
          borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.28)',
          transition: 'left .18s',
        },
      }))
      // ---- collapsible card wrapper: click the header to fold/unfold ----
      const card = {
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12))',
        borderRadius: 10, marginBottom: 12, overflow: 'hidden',
      }
      const cardSection = (id, icon, title, body) => {
        const isOpen = !collapsed[id]
        return h('section', { key: id, style: card },
          h('button', {
            type: 'button',
            onClick: () => setCollapsed((c) => Object.assign({}, c, { [id]: !c[id] })),
            style: {
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              padding: '12px 16px', border: 'none', background: 'transparent',
              cursor: 'pointer', textAlign: 'left',
              color: 'var(--dsw-alias-label-primary, #1a1a1a)',
            },
          },
            h('span', { style: { width: 4, height: 16, borderRadius: 2, flex: 'none', background: 'var(--dsw-alias-brand-primary, #3f7fbf)' } }),
            h('span', { style: { fontSize: 15, fontWeight: 600 } }, icon + ' ' + title),
            h('span', { style: { marginLeft: 'auto', fontSize: 12, opacity: .55 } }, isOpen ? '▾' : '▸')
          ),
          isOpen ? h('div', { style: { padding: '0 16px 12px' } }, body) : null
        )
      }
      const groupDesc = (text) => h('div', {
        style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #666)', margin: '2px 0 8px 12px' },
      }, text)
      const cardRow = (label, node, first) => h('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
          padding: '7px 0',
          borderTop: first ? 'none' : '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.07))',
        },
      }, h('span', { style: { fontSize: 13, lineHeight: '20px' } }, label), node)
      const toggle = (key, label, first) => cardRow(label,
        h(Switch, { checked: tb[key], disabled: !writable, onChange: (v) => setValue(key, v), label }), first)
      const masterToggle = (key, label, first) => cardRow(label,
        h(Switch, { checked: on(key, key === 'autoWakeOn' ? false : true), disabled: !writable, onChange: (v) => setValue(key, v), label }), first)

      const disabledHint = { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #888)', margin: '6px 0 0 12px' }
      const primaryBtn = Object.assign({}, controlStyle, {
        fontWeight: 600,
        border: '1px solid var(--dsw-alias-brand-primary, #3f7fbf)',
        background: 'var(--dsw-alias-brand-primary, #3f7fbf)',
        color: '#fff',
      })
      return h('div', { style: { maxWidth: 640, padding: '2px 0' } },
        // ---- card 0: master switches ----
        cardSection('master', '🎛️', t('masterTitle'), h('div', null,
          groupDesc(t('masterDesc')),
          masterToggle('notifyOn', t('notifyOn'), true),
          masterToggle('toolbarOn', t('toolbarOn')),
          masterToggle('autoWakeOn', t('autoWakeOn')),
          masterToggle('sysinfoOn', t('sysinfoOn')),
          masterToggle('encodingOn', t('encodingOn')),
          masterToggle('tokenCostOn', t('tokenCostOn')),
          masterToggle('conflictsOn', t('conflictsOn'))
        )),
        // ---- card 1: task notifications ----
        cardSection('notify', '🔔', t('notifyTitle'), h('div', null,
          !on('notifyOn', true) ? h('div', { style: disabledHint }, '— ' + t('notifyOn') + ' OFF —') : null,
          groupDesc(t('notifyDesc')),
          cardRow(t('mode'), h('select', {
            value: mode, disabled: !writable || !on('notifyOn', true),
            onChange: (e) => setMode(e.target.value), style: controlStyle,
          }, MODE_KEYS.map((k) => h('option', { key: k, value: k }, t(k)))), true),
          cardRow(t('subagent'), h(Switch, {
            checked: subagent, disabled: !writable || !on('notifyOn', true),
            onChange: (v) => setSubagent(v), label: t('subagent'),
          })),
          cardRow(
            h('span', null, t('autoWake'), h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #888)', marginTop: 3 } }, t('autoWakeDesc'))),
            h(Switch, {
              checked: on('autoWakeOn', false), disabled: !writable || !on('notifyOn', true),
              onChange: (v) => setValue('autoWakeOn', v), label: t('autoWake'),
            })
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', paddingTop: 10 } },
            h('button', { type: 'button', onClick: onTest, disabled: !on('notifyOn', true), style: primaryBtn }, t('test')),
            hint ? h('span', { style: { fontSize: 12, marginLeft: 10, opacity: .7 } }, hint) : null
          )
        )),
        // ---- card 2: selection toolbar ----
        cardSection('toolbar', '✂️', t('toolbarTitle'), h('div', null,
          !on('toolbarOn', true) ? h('div', { style: disabledHint }, '— ' + t('toolbarOn') + ' OFF —') : null,
          groupDesc(t('toolbarDesc')),
          h('div', { style: { fontSize: 12, opacity: .7, margin: '2px 0 0 12px' } }, t('buttons')),
          toggle('search', t('search'), true),
          toggle('translate', t('translate')),
          toggle('copy', t('copy')),
          toggle('ask', t('ask')),
          cardRow(t('searchEngine'), h('select', {
            value: tb.searchEngine, disabled: !writable,
            onChange: (e) => setValue('searchEngine', e.target.value), style: controlStyle,
          }, ENGINE_KEYS.map((k) => h('option', { key: k, value: k }, SEARCH_ENGINES[k].label)))),
          cardRow(t('translateDir'), h('select', {
            value: tb.translateDir, disabled: !writable,
            onChange: (e) => setValue('translateDir', e.target.value), style: controlStyle,
          }, DIR_KEYS.map((k) => h('option', { key: k, value: k }, DIRS[k]))))
        )),
        // ---- card 3: host tools (run in current chat) ----
        cardSection('tools', '🛠️', t('toolsTitle'), h('div', null,
          groupDesc(t('toolsDesc')),
          TOOL_RUNS.map((item, i) => cardRow(
            h('span', null,
              h('div', { style: { fontSize: 13, lineHeight: '18px' } }, t(item.key)),
              h('div', { style: { fontSize: 11, lineHeight: '15px', color: 'var(--dsw-alias-label-secondary, #888)' } }, t(item.desc))
            ),
            h('button', {
              type: 'button',
              onClick: () => onRun(item.msg),
              disabled: !on(item.key, true),
              style: primaryBtn,
            }, t('run')),
            i === 0
          ))
        )),
      )
    }

    // =====================================================================
    // floating toolbar component
    // =====================================================================
    function SelectionToolbar({ dismiss, readText, clearSelection, inputActions, getSettings }) {
      const s = normalizeToolbar(getSettings ? getSettings() : null)
      const [hint, setHint] = useState('')
      const text = readText() || ''

      useEffect(() => {
        if (!hint) return
        const timer = setTimeout(() => setHint(''), 1800)
        return () => clearTimeout(timer)
      }, [hint])

      const close = () => {
        try { clearSelection() } catch (_) {}
        dismiss()
      }
      const onSearch = () => {
        const eng = SEARCH_ENGINES[s.searchEngine] || SEARCH_ENGINES.bing
        window.open(eng.url(text), '_blank', 'noopener,noreferrer')
        close()
      }
      const onTranslate = () => {
        const lang = s.translateDir === 'auto' ? (hasCJK(text) ? 'zh2en' : 'en2zh') : s.translateDir
        const url = 'https://fanyi.baidu.com/mtpe-individual/transText?query=' + encodeURIComponent(text) + '&lang=' + lang
        window.open(url, '_blank', 'noopener,noreferrer')
        close()
      }
      const onCopy = async () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text)
            setHint(tv('copied'))
          } else {
            setHint(tv('clipboardUnavailable'))
          }
        } catch (_) {
          setHint(tv('copyFailed'))
        }
      }
      const onAsk = () => {
        if (inputActions && typeof inputActions.setDraft === 'function') {
          inputActions.setDraft(tv('askPrompt') + text)
          setHint(tv('asked'))
        } else {
          setHint(tv('askFailed'))
        }
      }
      const btn = (label, onClick, title) => h('button', {
        type: 'button', title: title || label,
        onPointerDown: (e) => e.preventDefault(),
        onClick: onClick,
        style: {
          cursor: 'pointer',
          border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.18))',
          background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,.05))',
          color: 'var(--dsw-alias-label-primary, #1a1a1a)',
          borderRadius: 6, padding: '4px 9px', fontSize: 12, lineHeight: '18px', whiteSpace: 'nowrap',
        },
      }, label)

      const buttons = []
      if (s.search) buttons.push(btn(tv('search'), onSearch, tv('searchTitle', { engine: (SEARCH_ENGINES[s.searchEngine] || {}).label })))
      if (s.translate) buttons.push(btn(tv('translate'), onTranslate, tv('translateTitle')))
      if (s.copy) buttons.push(btn(tv('copy'), onCopy, tv('copyTitle')))
      if (s.ask) buttons.push(btn(tv('ask'), onAsk, tv('askTitle')))

      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 4, padding: 4, borderRadius: 8,
          boxShadow: '0 4px 16px rgba(0,0,0,.25)',
          background: 'var(--dsw-alias-bg-overlay, #ffffff)',
          color: 'var(--dsw-alias-label-primary, #1a1a1a)',
          border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.18))',
        },
      },
        ...buttons,
        hint ? h('span', { key: 'hint', style: { fontSize: 11, opacity: .7, paddingLeft: 2 } }, hint) : null
      )
    }

    // =====================================================================
    // apply
    // =====================================================================
    return {
      inject: ['slots', 'locale', 'configForms', 'uiConversation', 'remote', 'remote.session', 'sessions'],
      apply(ctx) {
        const form = ctx.configForms.get(ENTRY_ID)
        ctx.effect(() => ctx.locale.register(LOCALE, { en, zh }))
        const t = ctx.locale.bind(LOCALE)
        tr = t // bind the factory-level translator used by notifications / toolbar
        const cfg = () => (form.getSnapshot() && form.getSnapshot().value) || {}
        const isOn = (key, dflt) => (typeof cfg()[key] === 'boolean' ? cfg()[key] : dflt)

        // settings section contribution
        const face = () => ({
          hooks: { form },
          setMode: (v) => form.set('mode', v),
          setSubagent: (v) => form.set('subagent', v),
          setValue: (field, value) => form.set(field, value),
          testNotify: testNotification,
          runTool: (msgKey) => runTool(msgKey, ctx, form),
          t,
        })
        ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section', id: 'toolbox', order: 90,
                label: () => t('nav'), inject: face,
              },
              ToolboxSection
            ))))

        // selection toolbar registration
        ctx.effect(() => ctx.uiConversation.interactions.register({
          id: 'dsh-toolbar',
          onInteraction(request) {
            if (!isOn('toolbarOn', true)) return
            const text = request.readText()
            if (text === null || text.trim() === '') return
            if (request.trigger === 'contextmenu') {
              request.preventDefault()
              request.open()
              return
            }
            if (request.trigger === 'selection') {
              request.open()
            }
          },
        }), 'dsh-toolbox-gjkt: text interaction')
        ctx.slots.inject('conversation.chat.text-interaction', () => ctx.slots.register(
          { name: 'conversation.chat.text-interaction', key: 'dsh-toolbar', inject: faceForToolbar },
          SelectionToolbar
        ))
        function faceForToolbar() {
          return { getSettings: () => form.getSnapshot().value }
        }

        // task notification event listeners
        if (typeof window.Notification !== 'undefined') {
          console.log('[dsh-toolbox-gjkt] Notification.permission =', window.Notification.permission)
        }
        const running = new Map()
        const sessionsBus = new Map() // sessionId -> {ref, unsub, artifacts:Set, workflows:Set, baseline, released}
        const wakeFired = new Set()   // stable requestIds already sent (server is also idempotent)
        ctx.effect(() => {
          const remote = ctx.get('remote')
          if (!remote || typeof remote.$on !== 'function') {
            console.error('[dsh-toolbox-gjkt] remote service unavailable; notifications disabled')
            return () => {}
          }
          const settings = () => (form.getSnapshot() && form.getSnapshot().value) || {}

          // scan a durable-event window for artifacts / workflow settlements above baseline
          function collect(id, st, entries) {
            try {
              for (const entry of entries || []) {
                if (!entry || entry.type !== 'event') continue
                const ev = entry.event
                if (!ev || typeof ev.seq !== 'number' || ev.seq <= st.baseline) continue
                if (ev.type === 'deliverables/presented') {
                  const files = ev.data && ev.data.files
                  if (Array.isArray(files)) {
                    for (const f of files) {
                      if (f && typeof f.path === 'string' && f.path) st.artifacts.add(f.path)
                    }
                  }
                } else if (ev.type === 'tool-workflow/run-end') {
                  st.workflows.add(String((ev.data && ev.data.stopReason) || 'completed'))
                }
              }
            } catch (e) { console.warn('[dsh-toolbox-gjkt] collect error', e) }
          }

          function acquire(id) {
            if (sessionsBus.has(id)) return
            const st = { ref: null, binding: null, unsub: null, artifacts: new Set(), workflows: new Set(), baseline: -1, released: false }
            sessionsBus.set(id, st)
            let ref
            try {
              ref = ctx.get('sessions').retain(id, { source: 'toolboxNotify' })
            } catch (e) {
              console.warn('[dsh-toolbox-gjkt] retain failed', e); return
            }
            st.ref = ref
            Promise.resolve(ref.ready).then((binding) => {
              if (st.released || !binding || !binding.eventSource) return
              st.binding = binding
              const es = binding.eventSource
              try {
                const snap = es.getSnapshot()
                const ents = snap && snap.entries
                const last = ents && ents.length ? ents[ents.length - 1] : null
                if (last && last.event && typeof last.event.seq === 'number') st.baseline = last.event.seq
              } catch (_) {}
              st.unsub = es.subscribe(() => {
                try {
                  const snap = es.getSnapshot()
                  if (snap && snap.change && snap.change.kind === 'append') collect(id, st, snap.change.entries)
                } catch (_) {}
              })
              // catch events appended between retain() and subscribe()
              try {
                const snap = es.getSnapshot()
                if (snap && snap.entries) collect(id, st, snap.entries)
              } catch (_) {}
            }).catch(() => {})
          }

          function release(id) {
            const st = sessionsBus.get(id)
            if (!st) return null
            sessionsBus.delete(id)
            st.released = true
            try { if (st.unsub) st.unsub() } catch (_) {}
            try { if (st.ref) st.ref.release() } catch (_) {}
            return st
          }

          function notifyDone(id) {
            const st = sessionsBus.get(id)
            // final sweep: catch events appended before ref.ready/subscribe completed
            if (st && st.binding && st.binding.eventSource) {
              try {
                const snap = st.binding.eventSource.getSnapshot()
                if (snap && snap.entries) collect(id, st, snap.entries)
              } catch (_) {}
            }
            release(id)
            const name = titleOf(id, ctx) + tv('taskDoneSuffix')
            const lines = [name]
            if (st) {
              if (st.workflows.size) {
                const reasons = [...st.workflows].map((r) => tv('wf_' + r) || r).join('/')
                lines.push(tv('workflowNotice') + ' ' + reasons)
              }
              if (st.artifacts.size) {
                const shown = [...st.artifacts].map((p) => {
                  const s = String(p)
                  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
                  return i >= 0 ? s.slice(i + 1) : s
                })
                lines.push(tv('artifactNotice') + ' ' + shown.slice(0, 8).join(', ') + (shown.length > 8 ? '…' : ''))
              }
            }
            const s = settings()
            if (s.notifyOn !== false) autoNotify(id, tv('taskDone'), lines.join('\n'), s)

            // auto-continue: only on completion with real artifacts/workflow, only when backgrounded
            if (s.autoWakeOn === true && st && (st.artifacts.size || st.workflows.size) && isBackgrounded()) {
              const key = wakeKey(id, st)
              if (!wakeFired.has(key)) {
                wakeFired.add(key)
                let sessRemote = null
                try { sessRemote = (ctx.get && ctx.get('remote.session')) || null } catch (_) {}
                if (!sessRemote) sessRemote = (ctx.remote && ctx.remote.session) || (remote && remote.session) || null
                try {
                  if (sessRemote && typeof sessRemote.prompt === 'function') {
                    let timeZone
                    try { timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone } catch (_) {}
                    Promise.resolve(sessRemote.prompt({
                      requestId: key,
                      sessionId: id,
                      mode: 'queue',
                      content: [{ type: 'text', text: tv('autoWakeMsg') }],
                      clientTimeZone: timeZone,
                    })).then((res) => { if (res && res.ok === false) wakeFired.delete(key) })
                      .catch(() => { wakeFired.delete(key) })
                  } else {
                    wakeFired.delete(key)
                  }
                } catch (_) { wakeFired.delete(key) }
              }
            }
          }

          const offAdded = remote.$on('api-session/added', (summary) => {
            markSubagent(summary)
            if (summary && (summary.id || summary.sessionId)) {
              const id = summary.id || summary.sessionId
              if (summary.running === true) { running.set(id, true); acquire(id) }
            }
          })
          const offStatus = remote.$on('api-session/status', (sessionId, isRunning) => {
            const prev = running.get(sessionId) === true
            running.set(sessionId, !!isRunning)
            if (isRunning) {
              acquire(sessionId)
            } else if (prev && !isRunning) {
              notifyDone(sessionId)
            }
          })
          const offError = remote.$on('api-session/error', (sessionId, message) => {
            const s = settings()
            if (s.notifyOn === false) return
            const detail = typeof message === 'string' && message ? tv('errorSuffix') + message.slice(0, 120) : ''
            autoNotify(sessionId, tv('taskError'), titleOf(sessionId, ctx) + detail, s)
          })
          const offRemoved = remote.$on('api-session/removed', (sessionId) => {
            subagentIds.delete(sessionId)
            running.delete(sessionId)
            release(sessionId)
          })
          return () => {
            try { offAdded && offAdded() } catch (_) {}
            try { offStatus && offStatus() } catch (_) {}
            try { offError && offError() } catch (_) {}
            try { offRemoved && offRemoved() } catch (_) {}
            for (const id of [...sessionsBus.keys()]) release(id)
          }
        }, 'dsh-toolbox-gjkt.events')

        return () => {}
      },
    }
  },
})
