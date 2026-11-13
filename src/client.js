window.__ModuleLoader__.load({
  id: 'dsh-shiqu',
  factory(require) {
    const { createElement: h, useEffect, useState } = require('react')
    const prefix = '/api/dsh-shiqu'
    const statuses = {
      running: '正在研究', complete: '已收录', blocked: '内容审查拦截', failed: '运行失败',
      'import-pending': '等待写入记忆宫殿', 'no-match': '没有合适的新知识', 'no-interest': '没有兴趣线索',
      'daily-limit': '今天已运行一轮', 'no-model': '请选择有过对话的会话，或设置后台模型',
      'no-source': '请开启网页搜索或添加订阅', busy: '已有一轮在运行', interrupted: '上一轮中断',
    }
    const stages = {
      'engram-read': '读取记忆宫殿', topic: '提取研究主题', search: '搜索与订阅',
      select: '筛选资料', import: '写入记忆宫殿',
    }
    const entryStatus = {
      pending: '待写入', imported: '已收录', duplicate: '已存在', conflict: '入库冲突',
      expired: '已过期', blocked: '入库被拦截',
    }
    const sourceLabels = { web: '网页搜索', github: 'GitHub Releases', feed: 'RSS / Atom' }
    const row = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }
    const stack = { display: 'grid', gap: 16, maxWidth: 760, margin: '0 auto', padding: '12px 4px' }
    const card = { border: '1px solid var(--border, #8885)', borderRadius: 10, padding: 14, display: 'grid', gap: 10 }

    async function api(path, body, panelToken) {
      const response = await fetch(prefix + path, body === undefined ? { cache: 'no-store' } : {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-shiqu-panel-token': panelToken },
        body: JSON.stringify(body),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      return result
    }

    const button = (label, onClick, disabled = false, pressed) => h('button', {
      type: 'button', onClick, disabled, 'aria-pressed': pressed,
    }, label)

    function field(label, props) {
      return h('label', { style: row }, h('span', null, label), h('input', props))
    }

    function Section() {
      const [snapshot, setSnapshot] = useState(null)
      const [settings, setSettings] = useState(null)
      const [sessions, setSessions] = useState([])
      const [notice, setNotice] = useState('')
      const [working, setWorking] = useState(false)
      const [researching, setResearching] = useState(false)
      const [subscriptionType, setSubscriptionType] = useState('github')
      const [subscriptionValue, setSubscriptionValue] = useState('')

      async function refresh() {
        const current = await api('/state')
        setSnapshot(current)
        return current
      }

      useEffect(() => {
        let mounted = true
        api('/state').then(current => {
          if (mounted) {
            setSnapshot(current)
            setSettings(current.settings)
          }
        }).catch(error => { if (mounted) setNotice(error.message) })
        api('/sessions').then(current => {
          if (mounted) setSessions(current.sessions)
        }).catch(error => { if (mounted) setNotice(error.message) })
        const timer = setInterval(() => {
          api('/state').then(current => { if (mounted) setSnapshot(current) }).catch(() => undefined)
        }, 10_000)
        return () => {
          mounted = false
          clearInterval(timer)
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
          setNotice(error.message)
        } finally {
          setWorking(false)
        }
      }

      function update(key, value) {
        setSettings(current => ({ ...current, [key]: value }))
      }

      function toggle(id) {
        setSettings(current => ({ ...current, sessions: current.sessions.includes(id)
          ? current.sessions.filter(value => value !== id) : [...current.sessions, id] }))
      }

      function addSubscription() {
        const value = subscriptionValue.trim()
        if (!value || settings.subscriptions.length >= 12) return
        update('subscriptions', [...settings.subscriptions, { type: subscriptionType, value }])
        setSubscriptionValue('')
      }

      if (!snapshot || !settings) return h('p', { role: 'status' }, notice || '正在加载拾趣…')
      const post = (path, body) => api(path, body, snapshot.panelToken)
      const last = snapshot.latest
      const knownIds = new Set(sessions.map(session => session.id))
      const allSessions = [...sessions, ...settings.sessions.filter(id => !knownIds.has(id)).map(id => ({ id, title: '暂不可见' }))]
      const check = (label, key) => field(label, { type: 'checkbox', checked: settings[key],
        onChange: event => update(key, event.target.checked) })
      const save = () => act(async () => {
        await post('/settings', settings)
        setSettings((await api('/state')).settings)
        return '设置已保存。'
      })
      async function run() {
        setResearching(true)
        try {
          await act(async () => {
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
          last?.details.topic && h('div', null, '上次主题 · ' + last.details.topic),
          last?.details.stage && h('div', null, '阶段 · ' + (stages[last.details.stage] ?? last.details.stage)),
          last?.details.code && h('code', null, last.details.code),
          last?.details.filtered > 0 && h('div', null, '被拦截的来源 · ' + last.details.filtered),
          last?.details.failed > 0 && h('div', null, '读取失败的来源 · ' + last.details.failed),
          last?.details.unreadable > 0 && h('div', null, '暂时读不到的已选会话 · ' + last.details.unreadable),
          h('div', { style: row }, button(researching || snapshot.busy ? '正在研究…' : '立即研究一轮',
            run, working || snapshot.busy),
            h('span', { role: 'status', 'aria-live': 'polite' }, notice))),
        h('section', { style: card, 'aria-label': '设置' },
          h('strong', null, '设置'),
          h('div', { style: row }, check('开启自动研究', 'enabled'), check('允许相邻主题', 'explore'),
            check('使用 DSH 网页搜索', 'webSearch')),
          field('每日兜底时间', { type: 'time', value: settings.fallbackAt,
            onChange: event => update('fallbackAt', event.target.value) }),
          field('时区', { value: settings.timeZone, onChange: event => update('timeZone', event.target.value) }),
          h('div', { style: row },
            field('模型提供商 ID', { value: settings.provider, placeholder: '留空使用所选会话的模型',
              onChange: event => update('provider', event.target.value) }),
            field('模型 ID', { value: settings.model, onChange: event => update('model', event.target.value) })),
          h('fieldset', null, h('legend', null, '允许读取的会话'),
            allSessions.length ? h('div', { style: { ...stack, gap: 4, maxHeight: 210, overflowY: 'auto', margin: 0 } },
              allSessions.map(session => h('label', { key: session.id, style: row },
                h('input', { type: 'checkbox', disabled: settings.sessions.length >= 12 && !settings.sessions.includes(session.id),
                  checked: settings.sessions.includes(session.id), onChange: () => toggle(session.id) }),
                h('span', { title: session.id }, session.title ? session.title + ' · ' + session.id.slice(0, 8) : session.id)))) :
              h('p', null, '没有可选会话。先在 DSH 中创建会话，再重新打开此面板。')),
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
          h('div', null, button('保存设置', save, working))),
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
