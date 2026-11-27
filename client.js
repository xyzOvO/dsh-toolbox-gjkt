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
    // Factory-level getter, wired in apply() to read the live volatile config so
    // chime changes apply immediately without a reload.
    let currentChime = () => 'dual'
    // Click-to-jump: wired in apply() from ctx.uiWorkspace. Kept at factory scope
    // so fireNotification can call it. liveNotifications keeps a strong ref so
    // the browser does not GC the Notification and drop its click handler.
    let jumpToSession = () => {}
    let notifyJumpOn = () => true
    const liveNotifications = new Set()

    // =====================================================================
    // push-to-talk voice input (drives the official voice-input bundle's
    // microphone button through its localized aria-label — no host changes,
    // no separate plugin, no package.json inject change)
    // =====================================================================
    const VOICE_START_LABELS = [
      '开始录音', 'Start recording', '録音を開始', 'Empezar a grabar',
      "Commencer l'enregistrement", 'Starten Sie die Aufnahme', 'Начать запись', 'Comece a gravar',
    ]
    const VOICE_STOP_LABELS = [
      '停止并识别', 'Stop and transcribe', '停止して文字起こし', 'Detener y transcribir',
      'Arrêtez et transcrivez', 'Stoppen Sie und transkribieren Sie', 'Остановись и перепиши', 'Pare e transcreva',
    ]
    const VOICE_PTT_KEY = 'dsh-toolbox.voicePtt'
    let voicePttOn = () => false
    function pttEnabled() { try { return localStorage.getItem(VOICE_PTT_KEY) === 'on' } catch (_) { return false } }
    function setPttEnabled(v) { try { localStorage.setItem(VOICE_PTT_KEY, v ? 'on' : 'off') } catch (_) {} }
    let pttRecording = false
    let pttArmTimer = null
    function voiceButton(labels) {
      for (const label of labels) {
        try {
          const el = document.querySelector('button[aria-label="' + label + '"]')
          if (el && !el.disabled) return el
        } catch (_) {}
      }
      return null
    }
    function voicePttStart() {
      if (pttRecording) return
      const btn = voiceButton(VOICE_START_LABELS)
      if (btn) { pttRecording = true; try { btn.click() } catch (_) {} }
    }
    function voicePttStop(attempt) {
      if (pttArmTimer) { clearTimeout(pttArmTimer); pttArmTimer = null }
      if (!pttRecording) return
      const btn = voiceButton(VOICE_STOP_LABELS)
      if (btn) {
        pttRecording = false
        try { btn.click() } catch (_) {}
        return
      }
      // official UI may still be in 'requesting' (mic permission / warm-up)
      // and hasn't rendered the stop button yet — retry a few times.
      const n = attempt || 0
      if (n < 8) setTimeout(() => voicePttStop(n + 1), 150)
      else pttRecording = false
    }
    function onVoiceKeyDown(e) {
      if (!voicePttOn()) return
      if (!e || e.key !== 'Alt' || e.ctrlKey || e.metaKey || e.shiftKey) return
      if (pttRecording || pttArmTimer) return
      try { e.preventDefault() } catch (_) {}
      // arm after a short delay: a quick Alt tap or Alt+Tab must not start recording
      pttArmTimer = setTimeout(() => { pttArmTimer = null; voicePttStart() }, 180)
    }
    function onVoiceKeyUp(e) {
      if (!voicePttOn()) return
      if (!e || e.key !== 'Alt') return
      voicePttStop()
    }
    function onVoiceBlur() { voicePttStop() }

    function unlockAudio() {
      if (audioCtx) return
      const AC = window.AudioContext || window.webkitAudioContext
      if (!AC) return
      try { audioCtx = new AC() } catch (_) { audioCtx = null }
    }
    function playChime(kind) {
      const mode = currentChime()
      if (mode === 'off' || !audioCtx) return
      try {
        if (audioCtx.state === 'suspended') audioCtx.resume()
        const now = audioCtx.currentTime
        // Event-specific presets take priority over the user's chosen completion chime.
        // Each note: [frequency, start offset (s), duration (s)].
        let notes
        if (kind === 'error') {
          notes = [[440, 0, 0.22], [330, 0.14, 0.34]]      // low descending — warning
        } else if (kind === 'artifact') {
          notes = [[1046.5, 0, 0.14], [1318.5, 0.1, 0.14], [1568, 0.2, 0.24]] // crisp upward sparkle
        } else if (kind === 'workflow') {
          notes = [[784, 0, 0.2], [988, 0.15, 0.2], [1318.5, 0.3, 0.3]]       // steady triple
        } else {
          // completion / test: follow the user's chosen preset
          notes = mode === 'single' ? [[880, 0, 0.3]]
            : mode === 'triple' ? [[784, 0, 0.22], [988, 0.16, 0.22], [1318.5, 0.32, 0.32]]
            : [[880, 0, 0.3], [1174.66, 0.16, 0.3]] // dual (default)
        }
        notes.forEach(([freq, offset, dur]) => {
          const osc = audioCtx.createOscillator()
          const gain = audioCtx.createGain()
          osc.type = 'sine'
          osc.frequency.value = freq
          const t = now + offset
          gain.gain.setValueAtTime(0.0001, t)
          gain.gain.exponentialRampToValueAtTime(0.45, t + 0.02) // louder: 0.18 -> 0.45
          gain.gain.exponentialRampToValueAtTime(0.0001, t + dur)
          osc.connect(gain).connect(audioCtx.destination)
          osc.start(t)
          osc.stop(t + dur + 0.02)
        })
      } catch (_) { /* best effort */ }
    }
    function isBackgrounded() {
      if (typeof document === 'undefined') return true
      try { return document.hidden === true || document.hasFocus() === false } catch (_) { return true }
    }
    function fireNotification(title, body, sessionId, kind) {
      playChime(kind)
      if (typeof window.Notification === 'undefined') return 'no-Notification-API'
      if (window.Notification.permission !== 'granted') return 'perm=' + window.Notification.permission
      try {
        const n = new window.Notification(title, { body })
        liveNotifications.add(n) // keep alive so the click handler survives GC
        if (sessionId && notifyJumpOn()) {
          n.onclick = () => {
            try { jumpToSession(sessionId) } catch (_) {}
            try { window.focus() } catch (_) {} // best effort; cannot un-minimize
            try { n.close() } catch (_) {}
          }
        }
        n.onclose = () => { liveNotifications.delete(n); n.onclick = null }
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
    function autoNotify(sessionId, title, body, settings, kind) {
      const mode = settings && settings.mode ? settings.mode : 'background'
      const subagentOn = !!(settings && settings.subagent)
      if (mode === 'never') return 'disabled'
      if (subagentIds.has(sessionId) && !subagentOn) return 'subagent-off'
      if (mode === 'always') return fireNotification(title, body, sessionId, kind)
      if (!isBackgrounded()) return 'foreground'
      return fireNotification(title, body, sessionId, kind)
    }

    // =====================================================================
    // remote (ds-harness-remote) status helpers
    // Same-origin control route on the DSH WebServer, so the browser sends its
    // HttpOnly auth cookie automatically — no token in JS, no CORS, no host.call.
    // We use bare fetch/EventSource so this stays a client.js-only change.
    // =====================================================================
    const REMOTE_BASE = '/ds-harness-remote'
    function remoteCall(method, payload) {
      return new Promise((resolve, reject) => {
        try {
          const rpcId = 'tb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
          fetch(REMOTE_BASE + '/' + method, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId, method, payload: payload || {} }),
          })
            .then((r) => r.json())
            .then((full) => {
              const result = full && full.result
              if (result && result.ok) resolve(result.value)
              else reject(new Error((result && result.error && result.error.message) || 'rpc-failed'))
            })
            .catch(reject)
        } catch (e) { reject(e) }
      })
    }
    const remoteStatus = () => remoteCall('status')
    const remoteReconnect = () => remoteCall('host.reconnect')
    const remoteLogs = () => remoteCall('settings.logs.get', { filter: 'warn', limit: 30 })
    // Watchdog on/off is kept in localStorage so toggling it needs no Config
    // change (which would force a bundle reinstall). Default = on.
    const WD_KEY = 'dsh-toolbox.remoteWatchdog'
    const wdEnabled = () => { try { return localStorage.getItem(WD_KEY) !== 'off' } catch (_) { return true } }
    const setWdEnabled = (v) => { try { localStorage.setItem(WD_KEY, v ? 'on' : 'off') } catch (_) {} }

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
    const CHIME_KEYS = ['dual', 'single', 'triple', 'off']
    const CITE_FORMAT_KEYS = ['superscript', 'numeric', 'text']

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
      chime: 'Notification sound', chime_dual: 'Classic (two notes)',
      chime_single: 'Single chime', chime_triple: 'Three notes', chime_off: 'Off (silent)',
      subagent: 'Also notify when a subagent finishes',
      notifyJump: 'Click notification to open that session',
      notifyJumpHelp: 'Works while the DSH window is open or in the background. A minimized window cannot be restored by a web notification.',
      voicePtt: 'Push-to-talk voice input (hold Alt)',
      voicePttHelp: 'Hold Alt to start recording through the official voice input, release to transcribe into the draft. Requires the official voice bundle enabled. Bad transcript? Press Ctrl+Z once to undo the whole insertion. Windows may show the menu bar on a lone Alt — tell me if it does.',
      autoWake: 'Auto-continue after completion',
      testWake: 'Test auto-continue', wakeSent: 'Sent — watch this session continue on its own',
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
      // remote health card
      remoteTitle: 'Remote health',
      remoteDesc: 'Status of ds-harness-remote. Read-only plus a reconnect button; the plugin already auto-reconnects on its own.',
      remoteRefresh: 'Refresh', remoteReconnect: 'Reconnect now',
      remoteChecking: 'Checking…', remoteOnline: 'Online', remoteReconnecting: 'Reconnecting',
      remoteOffline: 'Offline', remoteUnknown: 'Unavailable',
      remoteClients: 'connected clients', remoteLastActive: 'last active',
      remoteChecked: 'checked', remoteNeedAuth: 'Authorization expired — please re-pair in the Remote panel.',
      remoteReconnectSent: 'Reconnect requested', remoteReconnectFail: 'Reconnect failed',
      remoteNoPlugin: 'ds-harness-remote is not running or its control route is unavailable.',
      remoteDiag: 'configured {c} · authorized {a}', remoteHostErr: 'last error',
      remoteDevice: 'device', remoteAccount: 'account', remoteRecovery: 'recovery until',
      remoteClientItem: '{n} · {p} · {m}', remoteNoClients: 'no connected clients',
      remoteLogs: 'connection logs', remoteLogLoading: 'loading…', remoteLogEmpty: 'no warnings logged',
      remoteWatchdog: 'keep-connected watchdog', remoteWatchdogOn: 'on — auto-reconnect if dropped',
      remoteWatchdogOff: 'off — paused', remoteWatchdogHelp: 'Checks status every 20s; if offline and not already reconnecting, requests one reconnect (60s cooldown). The plugin itself already auto-reconnects; this is a safety net.',
      remoteAutoReconnected: 'auto-reconnect requested',
      remoteLimit: 'Cannot fix by plugin: expired token, revoked device, leftover credential lock, or a crashed DSH process.',
      // citation corner marks
      citeTitle: 'Citation corner marks', citeDesc: 'Instructs the model to append a clickable source mark after sourced facts. Off by default.',
      citeFormat: 'mark format', citeFormat_superscript: 'Superscript [¹]', citeFormat_numeric: 'Number [1]', citeFormat_text: 'Label [source]',
      citeHelp: 'Injected into the system prompt every step, stronger than a rules file. The model must actually retrieve a source to cite it; generic knowledge is not marked.',
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
      chime: '通知提示音', chime_dual: '经典双音',
      chime_single: '单音', chime_triple: '三连音', chime_off: '关闭（静音）',
      subagent: '子代理完成也通知',
      notifyJump: '点通知跳到对应会话',
      notifyJumpHelp: '窗口开着或在后台时有效；窗口最小化时，网页通知无法把它拉回来。',
      voicePtt: '长按 Alt 语音输入（按住说话）',
      voicePttHelp: '长按 Alt 借用官方语音输入开始录音，松开自动转写并插入草稿。需先启用官方语音输入 bundle。输错了按一次 Ctrl+Z 就能整段撤回这段语音文字。Windows 上单独按 Alt 可能弹出菜单栏，如有此现象告诉我换键。',
      autoWake: '完成后自动续作',
      testWake: '测试自动续作', wakeSent: '已发送——看本会话自己接着跑',
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
      // remote health card
      remoteTitle: '远程连接巡检',
      remoteDesc: '读取 ds-harness-remote 的连接状态。只读 + 一键重连；插件本身已带自动重连，不用重复造。',
      remoteRefresh: '刷新状态', remoteReconnect: '立即重连',
      remoteChecking: '检查中…', remoteOnline: '在线', remoteReconnecting: '重连中',
      remoteOffline: '离线', remoteUnknown: '不可用',
      remoteClients: '已连接客户端', remoteLastActive: '最后活跃',
      remoteChecked: '检查于', remoteNeedAuth: '授权已过期——请到 Remote 面板重新配对。',
      remoteReconnectSent: '已请求重连', remoteReconnectFail: '重连请求失败',
      remoteNoPlugin: 'ds-harness-remote 未运行，或其控制路由不可用。',
      remoteDiag: '已配置 {c} · 已授权 {a}', remoteHostErr: '最近错误',
      remoteDevice: '设备', remoteAccount: '账号', remoteRecovery: '恢复到',
      remoteClientItem: '{n} · {p} · {m}', remoteNoClients: '暂无已连接客户端',
      remoteLogs: '连接日志', remoteLogLoading: '读取中…', remoteLogEmpty: '没有警告日志',
      remoteWatchdog: '保活看门狗', remoteWatchdogOn: '开 — 掉线时自动重连',
      remoteWatchdogOff: '关 — 已暂停', remoteWatchdogHelp: '每 20 秒检查状态；若离线且未在重连，请求一次重连（60 秒冷却）。插件本身已带自动重连，这是一层保险。',
      remoteAutoReconnected: '已自动请求重连',
      remoteLimit: '插件修不了的：token 过期、设备被吊销、凭据锁残留、DSH 进程崩溃——这些只能手动处理。',
      // citation corner marks
      citeTitle: '引用角标', citeDesc: '让模型在有出处的事实后附一个可点来源角标。默认关闭。',
      citeFormat: '角标格式', citeFormat_superscript: '上标 [¹]', citeFormat_numeric: '数字 [1]', citeFormat_text: '文字 [来源]',
      citeHelp: '每步注入系统提示词，比规则文件更稳。模型必须真检索到出处才会标；通用常识不标。',
    }

    // factory-level translator for runtime notifications / toolbar (no React hook here)
    let tr = (k) => String(k)
    let wdLastReconnect = 0 // remote watchdog cooldown timestamp
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
      const onTestWake = () => {
        // Reuse the session.prompt path: send the exact auto-continue bubble to
        // the current main session so the agent picks it up and runs on its own.
        const r = runTool('autoWakeMsg')
        setHint(r === 'ok' ? t('wakeSent') : t('failed') + ' (' + r + ')')
        setTimeout(() => setHint(''), r === 'ok' ? 2500 : 6000)
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
      const [collapsed, setCollapsed] = useState({ master: true, notify: true, toolbar: true, tools: true, remote: true, cite: true, voice: true })
      const [pttOn, setPttOn] = useState(pttEnabled())
      const togglePtt = (v) => { setPttEnabled(v); setPttOn(v) }
      // remote health state — read only when the card is opened
      const [remote, setRemote] = useState({ loading: false, data: null, error: null, at: null })
      const [remoteHint, setRemoteHint] = useState('')
      const [remoteLogsState, setRemoteLogsState] = useState({ loading: false, entries: null })
      const [watchOn, setWatchOn] = useState(wdEnabled())
      const toggleWatchdog = (v) => { setWdEnabled(v); setWatchOn(v) }
      const loadLogs = async () => {
        setRemoteLogsState((s) => Object.assign({}, s, { loading: true }))
        try {
          const raw = await remoteLogs()
          const entries = (raw && Array.isArray(raw.entries)) ? raw.entries : []
          setRemoteLogsState({ loading: false, entries })
        } catch (e) {
          setRemoteLogsState({ loading: false, entries: [] })
        }
      }
      const checkRemote = async () => {
        setRemote((r) => Object.assign({}, r, { loading: true, error: null }))
        try {
          const raw = await remoteStatus()
          // Host mode returns { mode:'local', available:false, host:{online,...} };
          // the real state lives under .host. Flatten it so the card reads it right.
          const data = raw && raw.host
            ? Object.assign({}, raw.host, { update: raw.update, deviceName: raw.deviceName })
            : (raw || {})
          setRemote({ loading: false, data, error: null, at: new Date() })
        } catch (e) {
          setRemote({ loading: false, data: null, error: String(e && e.message ? e.message : e), at: new Date() })
        }
      }
      const doReconnect = async () => {
        setRemoteHint(t('remoteChecking'))
        try {
          await remoteReconnect()
          setRemoteHint(t('remoteReconnectSent'))
          setTimeout(() => { checkRemote(); setRemoteHint('') }, 1200)
        } catch (e) {
          setRemoteHint(t('remoteReconnectFail'))
          setTimeout(() => setRemoteHint(''), 4000)
        }
      }
      // one-shot load the first time this card is expanded
      useEffect(() => {
        if (!collapsed.remote && remote.data === null && !remote.loading && remote.at === null) checkRemote()
      }, [collapsed.remote])
      // Keep-connected watchdog: poll status, request ONE reconnect when clearly
      // offline with a 60s cooldown. Skips when paused, mid-reconnect, or auth needed.
      useEffect(() => {
        if (!watchOn) return
        let cancelled = false
        const tick = async () => {
          if (cancelled) return
          try {
            const raw = await remoteStatus()
            if (cancelled) return
            const data = raw && raw.host ? raw.host : (raw || {})
            const offline = data.online === false
            const busy = data.reconnecting === true || data.accountRequired === true
            const cooled = Date.now() - wdLastReconnect > 60_000
            if (offline && !busy && cooled) {
              wdLastReconnect = Date.now()
              await remoteReconnect()
              if (!cancelled) setRemoteHint(t('remoteAutoReconnected'))
            }
          } catch (_) { /* route unavailable — do nothing */ }
        }
        const id = setInterval(tick, 20_000)
        return () => { cancelled = true; clearInterval(id) }
      }, [watchOn])
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
          masterToggle('conflictsOn', t('conflictsOn')),
          masterToggle('citeOn', t('citeTitle'))
        )),
        // ---- card 1: task notifications ----
        cardSection('notify', '🔔', t('notifyTitle'), h('div', null,
          !on('notifyOn', true) ? h('div', { style: disabledHint }, '— ' + t('notifyOn') + ' OFF —') : null,
          groupDesc(t('notifyDesc')),
          cardRow(t('mode'), h('select', {
            value: mode, disabled: !writable || !on('notifyOn', true),
            onChange: (e) => setMode(e.target.value), style: controlStyle,
          }, MODE_KEYS.map((k) => h('option', { key: k, value: k }, t(k)))), true),
          cardRow(t('chime'), h('select', {
            value: CHIME_KEYS.indexOf(value.chime) >= 0 ? value.chime : 'dual',
            disabled: !writable || !on('notifyOn', true),
            onChange: (e) => setValue('chime', e.target.value), style: controlStyle,
          }, CHIME_KEYS.map((k) => h('option', { key: k, value: k }, t('chime_' + k))))),
          cardRow(t('subagent'), h(Switch, {
            checked: subagent, disabled: !writable || !on('notifyOn', true),
            onChange: (v) => setSubagent(v), label: t('subagent'),
          })),
          cardRow(
            h('span', null, t('notifyJump'), h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #888)', marginTop: 3 } }, t('notifyJumpHelp'))),
            h(Switch, {
              checked: on('notifyJump', true), disabled: !writable || !on('notifyOn', true),
              onChange: (v) => setValue('notifyJump', v), label: t('notifyJump'),
            })
          ),
          cardRow(
            h('span', null, t('autoWake'), h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #888)', marginTop: 3 } }, t('autoWakeDesc'))),
            h(Switch, {
              checked: on('autoWakeOn', false), disabled: !writable || !on('notifyOn', true),
              onChange: (v) => setValue('autoWakeOn', v), label: t('autoWake'),
            })
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', paddingTop: 10, gap: 10 } },
            h('button', { type: 'button', onClick: onTest, disabled: !on('notifyOn', true), style: primaryBtn }, t('test')),
            h('button', { type: 'button', onClick: onTestWake, style: primaryBtn }, t('testWake')),
            hint ? h('span', { style: { fontSize: 12, opacity: .7 } }, hint) : null
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
        // ---- card 4: remote health (ds-harness-remote, same-origin control route) ----
        cardSection('remote', '📡', t('remoteTitle'), h('div', null,
          groupDesc(t('remoteDesc')),
          (() => {
            let label, color
            if (remote.loading) { label = t('remoteChecking'); color = '#888' }
            else if (remote.error || !remote.data) { label = t('remoteUnknown'); color = '#888' }
            else if (remote.data.online) { label = t('remoteOnline'); color = '#2e8b57' }
            else if (remote.data.reconnecting) { label = t('remoteReconnecting'); color = '#d68910' }
            else { label = t('remoteOffline'); color = '#888' }
            return cardRow(t('remoteChecked') + (remote.at ? ' ' + remote.at.toLocaleTimeString() : ''),
              h('span', { style: { fontWeight: 600, color } }, label), true)
          })(),
          remote.data && typeof remote.data.configured === 'boolean'
            ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #888)', padding: '4px 0' } },
                tv('remoteDiag', { c: remote.data.configured ? '✓' : '✗', a: remote.data.authorized ? '✓' : '✗' }))
            : null,
          remote.data && remote.data.deviceName
            ? cardRow(t('remoteDevice'), h('span', null, String(remote.data.deviceName)))
            : null,
          remote.data && remote.data.account && (remote.data.account.email || remote.data.account.name)
            ? cardRow(t('remoteAccount'), h('span', null, String(remote.data.account.email || remote.data.account.name)))
            : null,
          remote.data && remote.data.lastActiveAt
            ? cardRow(t('remoteLastActive'), h('span', null, new Date(remote.data.lastActiveAt).toLocaleString()))
            : null,
          remote.data && remote.data.recoveryExpiresAt
            ? cardRow(t('remoteRecovery'), h('span', null, new Date(remote.data.recoveryExpiresAt).toLocaleString()))
            : null,
          remote.data && remote.data.error
            ? h('div', { style: { fontSize: 11, color: '#c0392b', padding: '4px 0' } }, t('remoteHostErr') + ': ' + String(remote.data.error))
            : null,
          remote.data && remote.data.accountRequired
            ? h('div', { style: { fontSize: 12, color: '#c0392b', padding: '4px 0' } }, t('remoteNeedAuth'))
            : null,
          remote.data && remote.data.connectedClients
            ? (remote.data.connectedClients.length
                ? h('div', { style: { padding: '4px 0' } },
                    h('div', { style: { fontSize: 12, fontWeight: 600, paddingBottom: 2 } }, t('remoteClients') + ': ' + remote.data.connectedClients.length),
                    ...remote.data.connectedClients.map((c, i) => h('div', { key: i, style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #888)', padding: '1px 0' } },
                      tv('remoteClientItem', { n: c.name || c.deviceId || '?', p: c.platform || '-', m: c.mode || '-' }))))
                : h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #888)', padding: '4px 0' } }, t('remoteNoClients')))
            : null,
          remote.error
            ? h('div', { style: { fontSize: 11, color: '#c0392b', padding: '4px 0' } }, t('remoteNoPlugin'))
            : null,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, paddingTop: 10, flexWrap: 'wrap' } },
            h('button', { type: 'button', onClick: checkRemote, disabled: remote.loading, style: controlStyle }, t('remoteRefresh')),
            h('button', { type: 'button', onClick: doReconnect, style: primaryBtn }, t('remoteReconnect')),
            h('button', { type: 'button', onClick: loadLogs, disabled: remoteLogsState.loading, style: controlStyle }, t('remoteLogs')),
            remoteHint ? h('span', { style: { fontSize: 12, opacity: .7 } }, remoteHint) : null
          ),
          remoteLogsState.loading
            ? h('div', { style: { fontSize: 11, color: '#888', paddingTop: 6 } }, t('remoteLogLoading'))
            : (remoteLogsState.entries !== null
                ? h('div', { style: { paddingTop: 6 } },
                    remoteLogsState.entries.length === 0
                      ? h('div', { style: { fontSize: 11, color: '#888' } }, t('remoteLogEmpty'))
                      : remoteLogsState.entries.slice(-8).map((e, i) => h('div', {
                          key: i,
                          style: { fontSize: 10, fontFamily: 'monospace', color: 'var(--dsw-alias-label-secondary, #888)', padding: '1px 0', wordBreak: 'break-all' },
                        }, e.line || (e.timestamp + ' ' + e.level + ' ' + e.message))))
                : null),
          cardRow(t('remoteWatchdog'), h('span', null,
            h(Switch, { checked: watchOn, onChange: toggleWatchdog, label: t('remoteWatchdog') }),
            h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #888)', marginLeft: 8 } },
              watchOn ? t('remoteWatchdogOn') : t('remoteWatchdogOff')))),
          h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #888)', padding: '2px 0', lineHeight: '16px' } }, t('remoteWatchdogHelp')),
          h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #888)', paddingTop: 8, lineHeight: '16px' } }, t('remoteLimit'))
        )),
        // ---- card 5: citation corner marks ----
        cardSection('cite', '🔖', t('citeTitle'), h('div', null,
          !on('citeOn', false) ? h('div', { style: disabledHint }, '— ' + t('citeTitle') + ' OFF —') : null,
          groupDesc(t('citeDesc')),
          cardRow(t('citeFormat'), h('select', {
            value: CITE_FORMAT_KEYS.indexOf(value.citeFormat) >= 0 ? value.citeFormat : 'superscript',
            disabled: !writable || !on('citeOn', false),
            onChange: (e) => setValue('citeFormat', e.target.value), style: controlStyle,
          }, CITE_FORMAT_KEYS.map((k) => h('option', { key: k, value: k }, t('citeFormat_' + k)))), true),
          h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #888)', paddingTop: 6, lineHeight: '16px' } }, t('citeHelp'))
        )),
        // ---- card 6: push-to-talk voice input ----
        cardSection('voice', '🎤', t('voicePtt'), h('div', null,
          groupDesc(t('voicePttHelp')),
          cardRow(t('voicePtt'), h(Switch, {
            checked: pttOn, onChange: togglePtt, label: t('voicePtt'),
          }), true)
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
      inject: ['slots', 'locale', 'configForms', 'uiConversation', 'remote', 'remote.session', 'sessions', 'uiWorkspace'],
      apply(ctx) {
        const form = ctx.configForms.get(ENTRY_ID)
        ctx.effect(() => ctx.locale.register(LOCALE, { en, zh }))
        const t = ctx.locale.bind(LOCALE)
        tr = t // bind the factory-level translator used by notifications / toolbar
        const cfg = () => (form.getSnapshot() && form.getSnapshot().value) || {}
        currentChime = () => (CHIME_KEYS.indexOf(cfg().chime) >= 0 ? cfg().chime : 'dual')
        notifyJumpOn = () => cfg().notifyJump !== false
        voicePttOn = () => pttEnabled()
        try {
          window.addEventListener('keydown', onVoiceKeyDown, true)
          window.addEventListener('keyup', onVoiceKeyUp, true)
          window.addEventListener('blur', onVoiceBlur)
        } catch (_) {}
        jumpToSession = (sessionId) => {
          const uw = ctx.get('uiWorkspace') || (ctx.uiWorkspace)
          if (uw && typeof uw.openSession === 'function') uw.openSession(sessionId)
        }
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
            // pick the heaviest event for the chime: artifact > workflow > plain completion
            const doneKind = st && st.artifacts.size ? 'artifact' : (st && st.workflows.size ? 'workflow' : 'done')
            if (s.notifyOn !== false) autoNotify(id, tv('taskDone'), lines.join('\n'), s, doneKind)

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
            autoNotify(sessionId, tv('taskError'), titleOf(sessionId, ctx) + detail, s, 'error')
          })
          const offRemoved = remote.$on('api-session/removed', (sessionId) => {
            subagentIds.delete(sessionId)
            running.delete(sessionId)
            release(sessionId)
          })

          // Startup seed + resync: on a page refresh the in-memory `running` map
          // is empty, and a session that was already running emits no fresh
          // status:true after we subscribe. Without this, its eventual status:false
          // sees prev=false and never notifies. Seed from the live session list,
          // and keep resyncing on list changes in case the snapshot wasn't populated
          // yet at effect time. acquire()/running.has dedupe so this stays cheap.
          let offList = null
          try {
            const sessionsSvc = ctx.get('sessions')
            const list = sessionsSvc && sessionsSvc.list
            const seed = () => {
              const byId = list && list.getSnapshot().byId
              if (!byId) return
              for (const id of Object.keys(byId)) {
                const row = byId[id]
                if (!row) continue
                markSubagent(row)
                if (row.running === true && !running.has(id)) { running.set(id, true); acquire(id) }
              }
            }
            seed()
            if (list && typeof list.subscribe === 'function') offList = list.subscribe(seed)
          } catch (e) { console.warn('[dsh-toolbox-gjkt] startup seed failed', e) }

          return () => {
            try { offAdded && offAdded() } catch (_) {}
            try { offStatus && offStatus() } catch (_) {}
            try { offError && offError() } catch (_) {}
            try { offRemoved && offRemoved() } catch (_) {}
            try { offList && offList() } catch (_) {}
            for (const id of [...sessionsBus.keys()]) release(id)
          }
        }, 'dsh-toolbox-gjkt.events')

        return () => {
          try {
            window.removeEventListener('keydown', onVoiceKeyDown, true)
            window.removeEventListener('keyup', onVoiceKeyUp, true)
            window.removeEventListener('blur', onVoiceBlur)
          } catch (_) {}
        }
      },
    }
  },
})
