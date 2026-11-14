window.__ModuleLoader__.load({
  id: 'dsh-shiqu',
  factory(require) {
    const { createElement: h, useEffect, useRef, useState } = require('react')
    const prefix = '/api/dsh-shiqu'
    const statuses = {
      running: '正在研究', complete: '已收录', blocked: '内容审查拦截', failed: '运行失败',
      'import-pending': '等待写入记忆宫殿', 'no-match': '没有合适的新知识', 'no-interest': '没有兴趣线索',
      'daily-limit': '今日自动研究次数已达上限', 'no-model': '请选择研究会话，或设置后台模型',
      'research-session-unavailable': '研究会话暂不可用，请重新选择并保存。',
      'research-session-no-model': '请先在研究会话里选择一个模型，再回来启动研究。',
      'no-source': '请开启网页搜索或添加订阅', busy: '已有一轮在运行', interrupted: '上一轮中断',
    }
    const stages = {
      'engram-read': '读取记忆宫殿', topic: '提取研究主题', search: '搜索与订阅',
      summary: '总结选中会话', select: '筛选资料', import: '写入记忆宫殿',
    }
    const entryStatus = {
      pending: '待写入', imported: '已收录', duplicate: '已存在', conflict: '入库冲突',
      expired: '已过期', blocked: '入库被拦截',
    }
    const sourceLabels = { web: '网页搜索', github: 'GitHub Releases', feed: 'RSS / Atom' }
    const row = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }
    const stack = { display: 'grid', gap: 16, maxWidth: 760, margin: '0 auto', padding: '12px 4px' }
    const card = { border: '1px solid var(--border, #8885)', borderRadius: 10, padding: 14, display: 'grid', gap: 10 }
    const statePollMs = 10_000
    const saveDelayMs = 700

    async function api(path, body, panelToken) {
      const response = await fetch(prefix + path, body === undefined ? { cache: 'no-store' } : {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-shiqu-panel-token': panelToken },
        body: JSON.stringify(body), keepalive: path === '/settings',
      })
      // The Host's unmatched route can return plain text "not found", not JSON.
      // Report the actual routing problem instead of a misleading JSON SyntaxError.
      const raw = await response.text()
      let result
      try {
        result = JSON.parse(raw)
      } catch {
        if (response.status === 404) {
          throw new Error(`拾趣后台接口不存在（HTTP 404 · ${path}）。请检查 Desktop profile 中插件是否已启用、Host 是否成功加载，然后完全重启 DSH。`)
        }
        throw new Error(`拾趣后台响应不是 JSON（HTTP ${response.status} · ${path}）。请检查 DSH Host 日志。`)
      }
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error(`拾趣后台响应格式错误（HTTP ${response.status} · ${path}）。`)
      }
      if (!response.ok) {
        const error = new Error(typeof result.error === 'string' ? result.error : `拾趣请求失败（HTTP ${response.status} · ${path}）。`)
        error.status = response.status
        error.code = result.code
        error.reason = result.reason
        error.hint = result.hint
        throw error
      }
      return result
    }

    const button = (label, onClick, disabled = false, pressed) => h('button', {
      type: 'button', onClick, disabled, 'aria-pressed': pressed,
    }, label)

    function field(label, props) {
      return h('label', { style: row }, h('span', null, label), h('input', props))
    }

    function sessionLabel({ id, title }) {
      return title ? title + ' · ' + id.replace(/^session-/, '').slice(0, 8) : id
    }

    function errorText(error) {
      return [error.message, error.hint, error.reason ?? error.code].filter(Boolean).join(' ')
    }

    function Section() {
      const [snapshot, setSnapshot] = useState(null)
      const [settings, setSettings] = useState(null)
      const [sessions, setSessions] = useState(null)
      const [loadError, setLoadError] = useState(null)
      const [sessionError, setSessionError] = useState('')
      const [diagnostics, setDiagnostics] = useState(null)
      const [notice, setNotice] = useState('')
      const [working, setWorking] = useState(false)
      const [researching, setResearching] = useState(false)
      const [saveStatus, setSaveStatus] = useState('')
      const panel = useRef({ token: undefined, mounted: false, retry: undefined })
      const draft = useRef({ settings: null, revision: 0, savedRevision: 0, timer: undefined, pending: undefined })
      const saveQueue = useRef(Promise.resolve())
      const [subscriptionType, setSubscriptionType] = useState('github')
      const [subscriptionValue, setSubscriptionValue] = useState('')

      async function refresh() {
        const current = await api('/state')
        if (panel.current.mounted) {
          panel.current.token = current.panelToken
          setSnapshot(current)
          setLoadError(null)
          if (!draft.current.settings) {
            draft.current.settings = current.settings
            setSettings(current.settings)
          }
        }
        return current
      }

      async function refreshSessions() {
        try {
          const current = await api('/sessions')
          if (!Array.isArray(current.sessions)) throw new Error('会话列表响应格式错误。')
          if (!panel.current.mounted) return false
          setSessions(current.sessions)
          setSessionError('')
          return true
        } catch (error) {
          if (panel.current.mounted) setSessionError(error.message)
          return false
        }
      }

      useEffect(() => {
        panel.current.mounted = true
        let active = true
        let loading = false
        let listed = false
        async function load(reloadSessions = false) {
          if (loading) return
          loading = true
          try {
            try {
              await refresh()
            } catch (error) {
              if (active) setLoadError(error)
              if (error.code !== 'SHIQU_STORAGE_UNAVAILABLE') return
            }
            if (active && (!listed || reloadSessions)) listed = await refreshSessions()
          } finally {
            loading = false
          }
        }
        function saveBeforeClosing() {
          if (draft.current.timer !== undefined) flushSettings().catch(() => undefined)
        }
        panel.current.retry = () => load(true)
        void load()
        const timer = setInterval(() => load(), statePollMs)
        window.addEventListener?.('pagehide', saveBeforeClosing)
        return () => {
          active = false
          panel.current.mounted = false
          clearInterval(timer)
          window.removeEventListener?.('pagehide', saveBeforeClosing)
          saveBeforeClosing()
        }
      }, [])

      async function act(operation) {
        setWorking(true)
        setNotice('')
        try {
          const message = await operation()
          if (message) setNotice(message)
          await refresh()
        } catch (error) {
          setNotice(errorText(error))
        } finally {
          setWorking(false)
        }
      }

      function update(key, value) {
        const current = draft.current
        current.settings = { ...current.settings, [key]: typeof value === 'function' ? value(current.settings[key]) : value }
        current.revision++
        setSettings(current.settings)
        setSaveStatus('有更改待保存。')
        clearTimeout(current.timer)
        current.timer = setTimeout(() => { flushSettings().catch(() => undefined) }, saveDelayMs)
      }

      function toggle(id) {
        update('sessions', current => current.includes(id)
          ? current.filter(value => value !== id) : [...current, id])
      }

      function addSubscription() {
        const value = subscriptionValue.trim()
        if (!value || settings.subscriptions.length >= 12) return
        update('subscriptions', [...settings.subscriptions, { type: subscriptionType, value }])
        setSubscriptionValue('')
      }

      function flushSettings() {
        const current = draft.current
        clearTimeout(current.timer)
        current.timer = undefined
        const { revision, settings: value } = current
        if (revision === current.savedRevision) return Promise.resolve()
        if (current.pending?.revision === revision) return current.pending.promise

        function showSaveStatus(message) {
          if (panel.current.mounted && current.revision === revision) setSaveStatus(message)
        }
        showSaveStatus('正在保存…')
        const promise = saveQueue.current.catch(() => undefined).then(async () => {
          try {
            await api('/settings', value, panel.current.token)
          } catch (error) {
            if (error.status !== 403 || !panel.current.mounted) throw error
            const refreshed = await refresh()
            await api('/settings', value, refreshed.panelToken)
          }
          current.savedRevision = revision
          showSaveStatus('设置已保存。')
        }).catch(error => {
          showSaveStatus('保存失败：' + errorText(error))
          throw error
        }).finally(() => {
          if (current.pending?.revision === revision) current.pending = undefined
        })
        current.pending = { revision, promise }
        saveQueue.current = promise
        return promise
      }

      const recovery = loadError && h('section', { style: card, 'aria-label': '拾趣故障恢复' },
        h('p', { role: 'status' }, loadError.message),
        loadError.hint && h('p', null, loadError.hint),
        loadError.code && h('code', null, [loadError.code, loadError.reason].filter(Boolean).join(' · ')),
        button('重试连接', () => panel.current.retry?.()),
        loadError.code === 'SHIQU_STORAGE_UNAVAILABLE' && h('div', null,
          h('strong', null, '会话列表（只读）'),
          sessionError && h('p', { role: 'status' }, sessionError),
          sessions === null ? h('p', null, sessionError ? '暂时无法列出会话。' : '正在加载会话…')
            : sessions.length ? h('ul', { style: { maxHeight: 210, overflowY: 'auto' } },
              sessions.map(session => h('li', { key: session.id }, sessionLabel(session))))
              : h('p', null, '没有可选会话。')))
      if (loadError?.code === 'SHIQU_STORAGE_UNAVAILABLE' || !snapshot || !settings) {
        return recovery || h('p', { role: 'status' }, '正在加载拾趣…')
      }
      const post = (path, body) => api(path, body, panel.current.token)
      const last = snapshot.latest
      const sessionList = sessions ?? []
      const knownIds = new Set(sessionList.map(session => session.id))
      const allSessions = [...sessionList, ...settings.sessions.filter(id => !knownIds.has(id)).map(id => ({ id, title: '暂不可见' }))]
      const researchOptions = settings.researchSession && !knownIds.has(settings.researchSession)
        ? [...sessionList, { id: settings.researchSession, title: '暂不可见' }] : sessionList
      const check = (label, key) => field(label, { type: 'checkbox', checked: settings[key],
        onChange: event => update(key, event.target.checked) })
      const save = () => flushSettings().catch(() => undefined)
      const diagnosticLabels = {
        readable: '可读取', 'not-found': '会话不存在', 'reader-unavailable': '缺少读取服务',
        'read-failed': '读取失败', 'invalid-history': '历史记录无效',
        'format-incompatible': '格式不兼容',
      }
      async function diagnose() {
        await act(async () => {
          await flushSettings()
          const result = await post('/diagnose', {})
          setDiagnostics(result.sessions)
          return '会话检查完成（不激活会话）。'
        })
      }
      async function run() {
        setResearching(true)
        try {
          await act(async () => {
            await flushSettings()
            const { outcome } = await post('/run', {})
            return statuses[outcome] ?? outcome
          })
        } finally {
          setResearching(false)
        }
      }

      return h('div', { style: stack },
        h('section', { style: card, 'aria-label': '运行状态' },
          h('strong', null, '运行状态'),
          h('div', null, last ? `${last.day} · ${statuses[last.outcome] ?? last.outcome}` : '尚未运行'),
          h('div', null, `今日自动研究 · ${snapshot.automaticCount ?? 0} / ${settings.dailyLimit}`),
          last?.details.topic && h('div', null, '上次主题 · ' + last.details.topic),
          last?.details.stage && h('div', null, '阶段 · ' + (stages[last.details.stage] ?? last.details.stage)),
          last?.details.code && h('code', null, last.details.code),
          last?.details.code === 'max-tokens' && h('small', null, '本次模型输出用尽了 Token 预算。可提高预算后重试。'),
          last?.details.filtered > 0 && h('div', null, '被拦截的来源 · ' + last.details.filtered),
          last?.details.failed > 0 && h('div', null, '读取失败的来源 · ' + last.details.failed),
          last?.details.unreadable > 0 && h('div', null, '暂时读不到的已选会话 · ' + last.details.unreadable),
          h('div', { style: row }, button(researching || snapshot.busy ? '正在研究…' : '立即研究（不受每日上限限制）',
            run, working || snapshot.busy),
            h('span', { role: 'status', 'aria-live': 'polite' }, notice))),
        h('section', { style: card, 'aria-label': '设置' },
          h('strong', null, '设置'),
          recovery,
          h('div', { style: row }, check('开启自动研究', 'enabled'), check('允许相邻主题', 'explore'),
            check('使用 DSH 网页搜索', 'webSearch')),
          field('每日兜底时间', { type: 'time', value: settings.fallbackAt,
            onChange: event => update('fallbackAt', event.target.value) }),
          field('时区', { value: settings.timeZone, onChange: event => update('timeZone', event.target.value) }),
          field('每日自动研究次数（1–24）', { type: 'number', min: 1, max: 24, step: 1,
            value: settings.dailyLimit, onChange: event => update('dailyLimit', event.target.value === '' ? '' : Number(event.target.value)) }),
          h('fieldset', null, h('legend', null, '模型 Token 预算'),
            h('div', null, '默认每次模型请求最多输出 8000 Token，主题选择和资料筛选分别使用该上限。'),
            h('label', { style: row },
              h('input', { type: 'checkbox', checked: settings.tokenBudget !== null,
                onChange: event => update('tokenBudget', event.target.checked ? 8000 : null) }),
              h('span', null, '自定义 Token 预算')),
            field('每次请求上限（512–65536）', { type: 'number', min: 512, max: 65536, step: 1,
              disabled: settings.tokenBudget === null, value: settings.tokenBudget ?? 8000,
              onChange: event => update('tokenBudget', event.target.value === '' ? '' : Number(event.target.value)) })),
          h('fieldset', null, h('legend', null, '后台研究'),
            h('label', { style: row }, h('span', null, '研究会话'),
              h('select', { value: settings.researchSession,
                onChange: event => update('researchSession', event.target.value) },
              h('option', { value: '' }, '请选择研究会话'),
              researchOptions.map(session => h('option', { key: session.id, value: session.id }, sessionLabel(session))))),
            h('small', null, '在该会话中选择要用的模型。每轮研究会单独总结已选兴趣会话（包括可读取的非活跃会话），不会向这些聊天发送消息。'),
            !settings.researchSession && h('details', { open: Boolean(settings.provider) || undefined },
              h('summary', null, '手动指定后台模型'),
              h('div', { style: row },
                field('模型提供商 ID', { value: settings.provider,
                  onChange: event => update('provider', event.target.value) }),
                field('模型 ID', { value: settings.model, onChange: event => update('model', event.target.value) })))),
          h('fieldset', null, h('legend', null, '兴趣来源 · 允许读取的会话'),
            sessionError && h('p', { role: 'status' }, sessionError),
            button('刷新会话列表', refreshSessions),
            allSessions.length ? h('div', { style: { ...stack, gap: 4, maxHeight: 210, overflowY: 'auto', margin: 0 } },
              allSessions.map(session => h('label', { key: session.id, style: row },
                h('input', { type: 'checkbox', disabled: settings.sessions.length >= 12 && !settings.sessions.includes(session.id),
                  checked: settings.sessions.includes(session.id), onChange: () => toggle(session.id) }),
                h('span', { title: session.id }, sessionLabel(session))))) :
              h('p', null, sessions ? '没有可选会话。创建会话后可以刷新列表。'
                : sessionError ? '暂时无法列出会话。' : '正在加载会话…')),
          h('div', { style: row }, button('检查已选会话读取状态', diagnose, working || snapshot.busy),
            h('small', null, '可诊断非活跃会话；不发送聊天内容给面板。')),
          diagnostics && h('div', { role: 'status', style: { display: 'grid', gap: 4 } },
            diagnostics.length ? diagnostics.map(item => h('div', { key: item.id },
              (sessionList.find(session => session.id === item.id)?.title || item.id.slice(0, 12)),
              ' · ', diagnosticLabels[item.status] || item.status,
              item.status === 'readable' ? ` · ${item.eventCount} 条事件${item.hasModel ? '' : ' · 未发现模型'}` : '')) :
              '没有选中的会话。'),
          h('fieldset', null, h('legend', null, '订阅来源'),
            h('div', { style: row },
              h('select', { 'aria-label': '订阅类型', value: subscriptionType,
                onChange: event => setSubscriptionType(event.target.value) },
              h('option', { value: 'github' }, 'GitHub Releases'), h('option', { value: 'feed' }, 'RSS / Atom')),
              h('input', { 'aria-label': '订阅地址', value: subscriptionValue,
                placeholder: subscriptionType === 'github' ? 'owner/repo' : 'https://example.com/feed.xml',
                onChange: event => setSubscriptionValue(event.target.value) }),
              button('添加订阅', addSubscription, !subscriptionValue.trim() || settings.subscriptions.length >= 12)),
            h('ul', null, settings.subscriptions.map((subscription, index) =>
              h('li', { key: subscription.type + subscription.value + index },
                subscription.value, ' ', button('移除', () => update('subscriptions', settings.subscriptions.filter((_, position) => position !== index))))))),
          h('div', { style: row }, button('立即保存设置', save, working),
            h('small', { role: 'status' }, saveStatus || '更改后约 0.7 秒自动保存'))),
        h('section', { style: card, 'aria-label': '收录记录' },
          h('strong', null, '收录记录'),
          snapshot.history.length ? snapshot.history.map(item => h('article', { key: item.id, style: card },
            h('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer' }, item.title),
            h('small', null, [item.topic, sourceLabels[item.source], entryStatus[item.status],
              item.published, new Date(item.added).toLocaleDateString()].filter(Boolean).join(' · ')),
            h('div', null, item.summary), h('small', null, '收录理由 · ' + item.reason),
            h('div', { style: row },
              button('有用', () => act(() => post('/feedback', { id: item.id, value: item.feedback === 1 ? 0 : 1 }).then(() => '反馈已保存。')),
                working, item.feedback === 1),
              button('少找这类', () => act(() => post('/feedback', { id: item.id, value: item.feedback === -1 ? 0 : -1 }).then(() => '反馈已保存。')),
                working, item.feedback === -1)))) : h('div', null, '收录的资料会出现在这里。')))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        slots.inject('settings.section', () => slots.register({
          name: 'settings.section', id: 'dsh-shiqu', order: 54, label: () => '拾趣',
        }, Section))
      },
    }
  },
})
