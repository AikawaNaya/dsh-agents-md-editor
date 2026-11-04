/**
 * Client half of `dsh-agents-md-editor`.
 *
 * Registers two occupants that share one id:
 *   - `sidebar.panellist` — the left-column entry icon (`PanelIcon`).
 *   - `main` keyed `agents-md-editor` — the editor page the entry opens.
 *
 * The page talks to the Host half over the plugin's own fenced route
 * (`/agents-md-editor/api/*`). It polls the file's sha1 version every couple of
 * seconds, so an edit made elsewhere (the agent, another editor, a Profile
 * reload) lands in the page without a manual refresh; while the buffer has
 * unsaved changes the poll never clobbers it and only raises a banner.
 *
 * Only React comes from the module table — no Harness Client package is
 * required, so nothing here breaks when those packages change.
 */
window.__ModuleLoader__.load({
  id: 'dsh-agents-md-editor',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** Occupant id shared by the sidebar entry and the main panel. */
    const PANEL_ID = 'agents-md-editor'
    /** Locale namespace owned by this plugin. */
    const NS = 'agents-md-editor'
    /** Host route, resolved relative to the page so a proxy prefix survives. */
    const API = 'agents-md-editor/api'
    /** How often the page checks the file version. */
    const POLL_MS = 2000

    /**
     * Survives the panel unmounting while the user looks at the conversation,
     * so switching panels does not silently drop an unsaved draft. Keyed by
     * the version it was drafted from: a stale entry is simply ignored.
     */
    let draftCache = null

    const DICT = {
      zh: {
        'panel.title': '代理说明编辑器',
        'chip.loading': '读取中',
        'chip.synced': '已同步',
        'chip.dirty': '未保存',
        'chip.external': '磁盘已变更',
        'chip.error': '读取失败',
        'chip.missing': '文件不存在',
        'action.save': '保存',
        'action.saving': '保存中…',
        'action.reload': '重新载入',
        'action.loadDisk': '载入磁盘版本',
        'banner.external': '磁盘上的文件被其他程序改过了。你的编辑还在，选择载入磁盘版本会丢弃它们。',
        'banner.dirty': '有未保存的修改。',
        'state.loading': '正在读取文件…',
        'state.error': '无法读取这个文件。',
        'error.conflict': '文件已被修改，保存被拒绝。请先载入磁盘版本。',
        'error.network': '无法连接 DSH 主机，稍后会自动重试。',
        'confirm.discard': '载入磁盘版本会丢弃当前未保存的修改，继续吗？',
        'foot.lines': '{n} 行',
        'foot.chars': '{n} 字符',
        'foot.saved': '上次保存 {time}',
        'foot.live': '实时同步中',
        'foot.hint': 'Ctrl+S 保存',
      },
      en: {
        'panel.title': 'Agent Instructions Editor',
        'chip.loading': 'Loading',
        'chip.synced': 'Synced',
        'chip.dirty': 'Unsaved',
        'chip.external': 'Changed on disk',
        'chip.error': 'Load failed',
        'chip.missing': 'File missing',
        'action.save': 'Save',
        'action.saving': 'Saving…',
        'action.reload': 'Reload',
        'action.loadDisk': 'Load from disk',
        'banner.external':
          'The file changed on disk. Your edits are still here — loading the disk version discards them.',
        'banner.dirty': 'You have unsaved changes.',
        'state.loading': 'Reading the file…',
        'state.error': 'This file could not be read.',
        'error.conflict': 'The file changed on disk, so the save was refused. Load the disk version first.',
        'error.network': 'Cannot reach the DSH host; retrying shortly.',
        'confirm.discard': 'Loading the disk version discards your unsaved changes. Continue?',
        'foot.lines': '{n} lines',
        'foot.chars': '{n} chars',
        'foot.saved': 'Saved at {time}',
        'foot.live': 'Live sync on',
        'foot.hint': 'Ctrl+S to save',
      },
    }

    const CSS = `
.ame-root {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  padding: calc(var(--dsh-frame-top-clearance, 0px) + 16px) 28px 18px;
  color: var(--dsw-alias-label-primary);
  font-size: var(--dsh-content-font-size, 14px);
}
.ame-head { flex: 0 0 auto; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.ame-head-main { min-width: 0; }
.ame-title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ame-title { margin: 0; font-size: calc(var(--dsh-content-font-size, 14px) + 1px); font-weight: 600; line-height: 1.4; letter-spacing: .01em; }
.ame-path {
  margin-top: 4px;
  font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, Menlo, monospace;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  word-break: break-all;
}
.ame-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.ame-btn {
  height: 30px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: 1;
  cursor: pointer;
  transition: background-color .12s ease, border-color .12s ease;
}
.ame-btn:hover:enabled { background: var(--dsw-alias-bg-layer-2); }
.ame-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.ame-btn:disabled { opacity: .45; cursor: default; }
.ame-btn-primary { border-color: transparent; background: var(--dsw-alias-brand-primary); color: #fff; }
.ame-btn-primary:hover:enabled { background: var(--dsw-alias-brand-primary); filter: brightness(1.08); }
.ame-btn-small { height: 24px; padding: 0 9px; font-size: var(--dsh-content-font-size-secondary, 13px); }
.ame-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: 1;
  white-space: nowrap;
}
.ame-chip-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: 0 0 auto; }
.ame-chip.is-synced { color: var(--dsw-alias-state-success-primary); }
.ame-chip.is-dirty, .ame-chip.is-external { color: var(--dsw-alias-state-warn-primary); }
.ame-chip.is-error { color: var(--dsw-alias-state-error-primary); }
.ame-banner {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-state-warn-primary);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: 1.5;
}
.ame-banner-text { flex: 1 1 auto; min-width: 0; }
.ame-banner.is-error { color: var(--dsw-alias-state-error-primary); }
.ame-editor {
  flex: 1 1 auto;
  box-sizing: border-box;
  width: 100%;
  min-height: 240px;
  padding: 14px 16px;
  resize: none;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, Menlo, monospace;
  font-size: var(--dsh-content-font-size, 14px);
  line-height: 1.7;
  tab-size: 2;
  outline: none;
}
.ame-editor:focus { border-color: var(--dsw-alias-brand-primary); }
.ame-empty {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 240px;
  border-radius: 10px;
  border: 1px dashed var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  font-size: var(--dsh-content-font-size-secondary, 13px);
}
.ame-foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
.ame-foot-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ame-foot-sep { opacity: .5; }
.ame-live { display: inline-flex; align-items: center; gap: 5px; }
.ame-live-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); }
`

    /** Locale face captured during apply; components read it while rendering. */
    let localeFace = null
    /** Translation function; falls back to the zh dictionary without a locale service. */
    let translate = (key, params) => interpolate(DICT.zh[key] ?? key, params)

    /**
     * Substitute `{name}` placeholders.
     * @param {string} template - Dictionary string.
     * @param {Record<string, unknown>} [params] - Values.
     * @returns {string} Rendered text.
     */
    function interpolate(template, params) {
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.hasOwn(params, name) ? String(params[name]) : match,
      )
    }

    /**
     * Resolve one Host route against the page's own base so a reverse-proxy
     * prefix is preserved (a leading `/` would pin the request to the origin
     * root and miss the route).
     * @param {string} action - Route leaf, e.g. `state`.
     * @returns {string} Absolute URL.
     */
    function apiUrl(action) {
      let base
      try {
        base = document.baseURI
      } catch {
        base = undefined
      }
      let resolved
      try {
        resolved = new URL(base ?? '/', typeof location === 'object' ? location.href : 'http://dsh.internal/')
      } catch {
        resolved = new URL('http://dsh.internal/')
      }
      resolved.search = ''
      resolved.hash = ''
      if (!resolved.pathname.endsWith('/')) resolved.pathname += '/'
      return new URL(`${API}/${action}`, resolved.href).toString()
    }

    /**
     * Call one Host route and unwrap the `{ ok, value | error }` envelope.
     * @param {string} action - Route leaf.
     * @param {RequestInit} [init] - Fetch options.
     * @returns {Promise<any>} The unwrapped value.
     */
    async function request(action, init) {
      let response
      try {
        response = await fetch(apiUrl(action), { credentials: 'same-origin', cache: 'no-store', ...init })
      } catch (error) {
        const failure = new Error(translate('error.network'))
        failure.code = 'network'
        throw failure
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload === null || typeof payload !== 'object') {
        const failure = new Error(`HTTP ${response.status}`)
        failure.code = 'http'
        throw failure
      }
      if (payload.ok !== true) {
        const failure = new Error(payload.error?.message ?? `HTTP ${response.status}`)
        failure.code = payload.error?.code ?? 'error'
        throw failure
      }
      return payload.value
    }

    /**
     * Re-render on every locale change so this subtree follows the UI language.
     * @returns {void}
     */
    function useLocaleTick() {
      const [, bump] = useState(0)
      useEffect(() => {
        if (localeFace === null || typeof localeFace.subscribe !== 'function') return undefined
        return localeFace.subscribe(() => bump((value) => value + 1))
      }, [])
    }

    /** Left-column entry icon; the host supplies the square edge and selected state. */
    function PanelIcon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 20
      const active = props.active === true
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 1.9 : 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
          style: { display: 'block' },
        },
        h('path', { d: 'M6.75 3.5h6.6l4.9 4.85V20.5H6.75z' }),
        h('path', { d: 'M13.1 3.7v4.7h4.85' }),
        h('path', { d: 'M9.4 12.3h5.4' }),
        h('path', { d: 'M9.4 15.5h3.7' }),
      )
    }

    /** The editor page rendered in the `main` slot. */
    function EditorPanel() {
      useLocaleTick()
      const [phase, setPhase] = useState('loading')
      const [filePath, setFilePath] = useState('')
      const [content, setContent] = useState('')
      const [saved, setSaved] = useState('')
      const [version, setVersion] = useState(null)
      const [mtimeMs, setMtimeMs] = useState(null)
      const [exists, setExists] = useState(true)
      const [external, setExternal] = useState(false)
      const [busy, setBusy] = useState(false)
      const [savedAt, setSavedAt] = useState(null)
      const [errorText, setErrorText] = useState('')

      const dirty = content !== saved
      /** Latest render state, read by long-lived callbacks and the poll timer. */
      const live = useRef({ content: '', saved: '', version: null, dirty: false, busy: false })
      live.current.content = content
      live.current.saved = saved
      live.current.version = version
      live.current.dirty = dirty
      live.current.busy = busy

      /** Adopt a Host snapshot as both buffer and saved baseline. */
      const adopt = useCallback((state) => {
        setExists(state.exists !== false)
        setFilePath(typeof state.path === 'string' ? state.path : '')
        setVersion(state.version ?? null)
        setMtimeMs(typeof state.mtimeMs === 'number' ? state.mtimeMs : null)
        setSaved(typeof state.content === 'string' ? state.content : '')
        setContent(typeof state.content === 'string' ? state.content : '')
        setExternal(false)
      }, [])

      // Initial load, plus restoring a draft that outlived a panel switch.
      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const state = await request('state')
            if (!alive) return
            adopt(state)
            const draft = draftCache
            if (
              draft !== null &&
              draft.path === state.path &&
              draft.version === state.version &&
              draft.content !== state.content
            ) {
              setContent(draft.content)
            }
            draftCache = null
            setPhase('ready')
          } catch (error) {
            if (!alive) return
            setErrorText(error.message)
            setPhase('error')
          }
        }
        load()
        return () => {
          alive = false
        }
      }, [adopt])

      // Keep the cross-mount draft cache in step with the buffer.
      useEffect(() => {
        if (phase !== 'ready') return
        if (content !== saved) draftCache = { path: filePath, version, content }
        else if (draftCache !== null && draftCache.path === filePath) draftCache = null
      }, [phase, filePath, version, content, saved])

      // Live view: notice an edit made outside this page.
      useEffect(() => {
        if (phase !== 'ready') return undefined
        let alive = true
        let timer = 0
        const tick = async () => {
          if (!alive) return
          try {
            const state = await request('state')
            if (!alive) return
            if (state.version !== live.current.version) {
              if (live.current.dirty) {
                setExternal(true)
                setMtimeMs(typeof state.mtimeMs === 'number' ? state.mtimeMs : null)
              } else {
                adopt(state)
                setSavedAt(null)
              }
            }
          } catch {
            // Transient: keep the current buffer and try again on the next tick.
          }
          if (alive) timer = window.setTimeout(tick, POLL_MS)
        }
        timer = window.setTimeout(tick, POLL_MS)
        return () => {
          alive = false
          window.clearTimeout(timer)
        }
      }, [phase, adopt])

      // Warn before a full page reload throws away unsaved text.
      useEffect(() => {
        if (!dirty) return undefined
        const handler = (event) => {
          event.preventDefault()
          event.returnValue = ''
          return ''
        }
        window.addEventListener('beforeunload', handler)
        return () => window.removeEventListener('beforeunload', handler)
      }, [dirty])

      /** Write the buffer back through the Host route, refusing a stale base. */
      const save = useCallback(async () => {
        if (live.current.busy) return
        setBusy(true)
        setErrorText('')
        const text = live.current.content
        const baseVersion = live.current.version
        try {
          const result = await request('save', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: text, baseVersion }),
          })
          setSaved(text)
          setVersion(result.version ?? null)
          setMtimeMs(typeof result.mtimeMs === 'number' ? result.mtimeMs : null)
          setExists(true)
          setExternal(false)
          setSavedAt(typeof result.savedAt === 'number' ? result.savedAt : Date.now())
          if (live.current.content === text) setContent(text)
        } catch (error) {
          if (error.code === 'conflict') {
            setExternal(true)
            setErrorText(translate('error.conflict'))
          } else {
            setErrorText(error.message)
          }
        } finally {
          setBusy(false)
        }
      }, [])

      /** Re-read the disk version, discarding a draft only after confirmation. */
      const reload = useCallback(async () => {
        if (live.current.dirty && typeof window.confirm === 'function') {
          if (!window.confirm(translate('confirm.discard'))) return
        }
        setBusy(true)
        setErrorText('')
        try {
          const state = await request('state')
          adopt(state)
          draftCache = null
          setSavedAt(null)
          setPhase('ready')
        } catch (error) {
          setErrorText(error.message)
        } finally {
          setBusy(false)
        }
      }, [adopt])

      const onChange = useCallback((event) => {
        setContent(event.target.value)
      }, [])

      const onKeyDown = useCallback(
        (event) => {
          if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
            event.preventDefault()
            save()
            return
          }
          if (event.key !== 'Tab') return
          event.preventDefault()
          const element = event.currentTarget
          const start = element.selectionStart
          const end = element.selectionEnd
          const value = element.value
          const next = `${value.slice(0, start)}  ${value.slice(end)}`
          setContent(next)
          window.requestAnimationFrame(() => {
            element.selectionStart = start + 2
            element.selectionEnd = start + 2
          })
        },
        [save],
      )

      const t = (key, params) => translate(key, params)
      const lines = content === '' ? 1 : content.split('\n').length
      const chips = []
      if (phase === 'loading') chips.push(['loading', 'is-loading'])
      else if (phase === 'error') chips.push(['error', 'is-error'])
      else if (!exists) chips.push(['missing', 'is-dirty'])
      if (external) chips.push(['external', 'is-external'])
      else if (dirty) chips.push(['dirty', 'is-dirty'])
      else if (phase === 'ready' && exists) chips.push(['synced', 'is-synced'])

      const statusChip = chips.map(([key, modifier]) =>
        h(
          'span',
          { key, className: `ame-chip ${modifier}` },
          h('i', { className: 'ame-chip-dot', 'aria-hidden': true }),
          t(`chip.${key}`),
        ),
      )

      return h(
        'div',
        { className: 'ame-root' },
        h('style', { 'data-agents-md-editor': '', key: 'ame-style' }, CSS),
        h(
          'header',
          { className: 'ame-head', key: 'ame-head' },
          h(
            'div',
            { className: 'ame-head-main' },
            h('div', { className: 'ame-title-row' }, h('h1', { className: 'ame-title' }, t('panel.title')), statusChip),
            h('div', { className: 'ame-path', title: filePath }, filePath),
          ),
          h(
            'div',
            { className: 'ame-actions' },
            h(
              'button',
              { type: 'button', className: 'ame-btn', onClick: reload, disabled: busy },
              t('action.reload'),
            ),
            h(
              'button',
              { type: 'button', className: 'ame-btn ame-btn-primary', onClick: save, disabled: busy || !dirty },
              busy ? t('action.saving') : t('action.save'),
            ),
          ),
        ),
        external
          ? h(
              'div',
              { className: 'ame-banner', role: 'status', key: 'ame-external' },
              h('span', { className: 'ame-banner-text' }, t('banner.external')),
              h(
                'button',
                { type: 'button', className: 'ame-btn ame-btn-small', onClick: reload, disabled: busy },
                t('action.loadDisk'),
              ),
            )
          : null,
        errorText
          ? h(
              'div',
              { className: 'ame-banner is-error', role: 'alert', key: 'ame-error' },
              h('span', { className: 'ame-banner-text' }, errorText),
            )
          : null,
        phase === 'loading'
          ? h('div', { className: 'ame-empty', key: 'ame-loading' }, t('state.loading'))
          : phase === 'error'
            ? h('div', { className: 'ame-empty', key: 'ame-failed' }, t('state.error'))
            : h('textarea', {
                key: 'ame-editor',
                className: 'ame-editor',
                value: content,
                onChange,
                onKeyDown,
                spellCheck: false,
                autoCapitalize: 'off',
                autoCorrect: 'off',
                wrap: 'off',
                'aria-label': t('panel.title'),
              }),
        h(
          'footer',
          { className: 'ame-foot', key: 'ame-foot' },
          h(
            'div',
            { className: 'ame-foot-meta' },
            h('span', null, t('foot.lines', { n: lines })),
            h('span', { className: 'ame-foot-sep' }, '·'),
            h('span', null, t('foot.chars', { n: content.length })),
            savedAt === null
              ? null
              : h('span', { className: 'ame-foot-sep', key: 'ame-saved-sep' }, '·'),
            savedAt === null
              ? null
              : h(
                  'span',
                  { key: 'ame-saved' },
                  t('foot.saved', { time: new Date(savedAt).toLocaleTimeString() }),
                ),
          ),
          h(
            'div',
            { className: 'ame-foot-meta' },
            h(
              'span',
              { className: 'ame-live' },
              h('i', { className: 'ame-live-dot', 'aria-hidden': true }),
              t('foot.live'),
            ),
            h('span', { className: 'ame-foot-sep' }, '·'),
            h('span', null, t('foot.hint')),
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get('locale')
        if (locale !== null && typeof locale === 'object' && typeof locale.register === 'function') {
          try {
            const dispose = locale.register(NS, DICT)
            if (typeof dispose === 'function') ctx.effect(() => dispose)
            if (typeof locale.bind === 'function') {
              const bound = locale.bind(NS)
              // Accept either a callable translate or an object exposing `t`,
              // and fall back to the bundled dictionary for a missing key:
              // a silent `undefined` here would blank every piece of UI copy.
              translate = (key, params) => {
                let value
                try {
                  value = typeof bound === 'function' ? bound(key, params) : bound?.t?.(key, params)
                } catch {
                  value = undefined
                }
                if (typeof value === 'string' && value !== '' && value !== key) return value
                return interpolate(DICT.zh[key] ?? key, params)
              }
            }
            localeFace = locale
          } catch (error) {
            console.error('dsh-agents-md-editor: locale registration failed', error)
          }
        }

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, EditorPanel),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => translate('panel.title') },
            PanelIcon,
          ),
        )
      },
    }
  },
})
