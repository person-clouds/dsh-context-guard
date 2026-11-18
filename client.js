/**
 * DSH context-guard Web 客户端：硬上限拒绝后，在空输入框中写入「继续」。
 * 不自动发送；用户按 Enter 才继续。Desktop/TUI 不加载此入口，静默降级。
 */
window.__ModuleLoader__.load({
  id: '@fenghoer/dsh-context-guard',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const CONTINUE_TEXT = '继续'
    const MARKER = 'context-guard:hard-limit-draft'
    const MAX_PER_SESSION = 3
    const RESTORE_WINDOW_MS = 30 * 60 * 1000
    const budgets = new Map()
    let pluginCtx

    function markerTurnOf(entry) {
      if (entry?.type !== 'event' || entry.event?.type !== 'tool/result') return undefined
      const event = entry.event
      const data = event.data
      const reason = data?.error?.reason
      if (typeof reason === 'string' && reason.includes(MARKER)) return { turn: data.turn, seq: event.seq, time: event.time }
      const content = data?.message?.content
      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part?.text === 'string' && part.text.includes(MARKER)) return { turn: data.turn, seq: event.seq, time: event.time }
        }
      }
      return undefined
    }

    function claim(sessionId, turn) {
      const key = String(sessionId)
      const record = budgets.get(key) ?? { count: 0, turns: new Set() }
      const turnKey = String(turn)
      if (record.count >= MAX_PER_SESSION || record.turns.has(turnKey)) return false
      record.count += 1
      record.turns.add(turnKey)
      budgets.set(key, record)
      return true
    }

    function ContinueDraftSeat({ sessionId, useInput, inputActions }) {
      const draft = typeof useInput === 'function' ? useInput(state => state.draft) : ''
      const draftRef = React.useRef(draft)
      draftRef.current = draft
      React.useEffect(() => {
        if (!sessionId || !inputActions) return undefined
        const binding = pluginCtx?.sessions.binding(sessionId)
        if (!binding) return undefined
        const tryEntries = (entries) => {
          if (draftRef.current !== '') return
          for (let index = entries.length - 1; index >= 0; index -= 1) {
            const hit = markerTurnOf(entries[index])
            if (!hit) continue
            if (typeof hit.time === 'number' && Date.now() - hit.time > RESTORE_WINDOW_MS) return
            if (!claim(sessionId, hit.turn)) return
            inputActions.setDraft(CONTINUE_TEXT)
            return
          }
        }
        tryEntries(binding.eventSource.getSnapshot().entries ?? [])
        return binding.eventSource.subscribe(() => {
          const snapshot = binding.eventSource.getSnapshot()
          if (snapshot.change?.kind === 'append') tryEntries(snapshot.change.entries)
        })
      }, [sessionId, inputActions])
      return null
    }

    const inject = ['slots', 'sessions']
    function apply(ctx) {
      pluginCtx = ctx
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'context-guard-continue-draft',
        order: 100,
      }, ContinueDraftSeat))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
