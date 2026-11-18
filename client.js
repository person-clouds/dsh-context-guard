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
    const RISK_RULE_ENDPOINT = '/api/context-guard-risk-rule'
    const RISK_RULE_TOKEN_RE = /rule-token:\s*([a-f0-9]{16,64})/
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


    function riskRuleToken(reason) {
      const match = RISK_RULE_TOKEN_RE.exec(String(reason || ''))
      return match ? match[1] : null
    }

    function isRiskApproval(interaction) {
      return interaction?.kind === 'approval' &&
        typeof interaction.reason === 'string' &&
        interaction.reason.includes('context-guard risk check') &&
        riskRuleToken(interaction.reason) !== null
    }

    function preferredText(approval) {
      const display = approval.displayReason
      if (display && typeof display === 'object') {
        const language = String(globalThis.navigator?.language || '').toLowerCase()
        if (language.startsWith('zh') && typeof display.zh === 'string') return display.zh
        if (typeof display.en === 'string') return display.en
      }
      return approval.reason
    }

    function riskDescription() {
      const language = String(globalThis.navigator?.language || '').toLowerCase()
      if (language.startsWith('zh')) {
        return '点击「始终允许」会把这条命令解析成窄规则：只自动放行完全相同的命令；若风险仅来自未知链接，则只放行该主机。高风险规则不会扩展到其它命令。'
      }
      return '“Always allow” parses this command into a narrow rule: only the exact same command is auto-allowed. If the risk is only an unknown link, only that host is allowed. High-risk rules never expand to other commands.'
    }

    async function saveRiskRuleAndAllow(approval) {
      const token = riskRuleToken(approval.reason)
      if (!token) throw new Error('missing risk rule token')
      const response = await fetch(RISK_RULE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'allow', token }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || body?.ok !== true) {
        throw new Error(body?.error || `risk rule request failed: ${response.status}`)
      }
      await approval.answer('allowed-once')
    }

    function RiskApprovalSeat(props) {
      const approval = props.matched
      return props.renderFactorySlot('conversation.approval.card', {
        requestKey: approval.key,
        title: preferredText(approval),
        description: riskDescription(),
        ...(approval.callId === undefined ? {} : { callId: approval.callId }),
        canAnswer: () => approval.answerable,
        allowLabel: props.t('allowOnce'),
        onAllow: () => approval.answer('allowed-once'),
        onReject: () => approval.answer('rejected'),
        onAlways: () => saveRiskRuleAndAllow(approval),
      })
    }

    const inject = ['slots', 'sessions']
    function apply(ctx) {
      pluginCtx = ctx
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'context-guard-continue-draft',
        order: 100,
      }, ContinueDraftSeat))
      ctx.slots.inject('conversation.composer', () => ctx.slots.register({
        name: 'conversation.composer',
        priority: 0,
        locale: 'approval',
        select: ({ pendingInteraction }) => isRiskApproval(pendingInteraction) ? pendingInteraction : null,
      }, RiskApprovalSeat))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
