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
    const SLOW_NOTICE_MS = 2000
    const REQUEST_TIMEOUT_MS = 15000
    const NOTICE_ID = 'context-guard-notice'
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
        return '点击「始终允许」会把命令解析成安全类规则：同一项目前缀下清理构建产物（node_modules、dist、build、.cache 等）会自动放行；未知链接只放行该主机；无法证明为安全类时只记住完全相同的命令。不会按高风险代码全量放行。'
      }
      return '“Always allow” parses the command into a safe-class rule: cleaning build artifacts (node_modules, dist, build, .cache, …) under the same project prefix is auto-allowed; unknown links allow only that host; when no safe class can be proven, only the exact command is remembered. High-risk codes are never wildcarded.'
    }

    function showNotice(text) {
      const doc = globalThis.document
      if (!doc?.body || typeof doc.createElement !== 'function') return
      let node = doc.getElementById(NOTICE_ID)
      if (!node) {
        node = doc.createElement('div')
        node.id = NOTICE_ID
        node.setAttribute('role', 'status')
        node.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;max-width:420px;padding:10px 14px;border-radius:8px;background:#1f2937;color:#fff;font-size:13px;line-height:1.5;box-shadow:0 4px 16px rgba(0,0,0,.3);white-space:pre-wrap'
        doc.body.appendChild(node)
      }
      node.textContent = String(text)
      node.style.display = 'block'
      const schedule = globalThis.setTimeout
      const cancel = globalThis.clearTimeout
      if (node.__cgHideTimer !== undefined && typeof cancel === 'function') cancel(node.__cgHideTimer)
      node.__cgHideTimer = typeof schedule === 'function'
        ? schedule(() => { node.style.display = 'none' }, 8000)
        : undefined
    }

    /** 失败必须可见：提示 + 控制台，错误码用于定位 Host 侧原因。 */
    function riskRuleFailure(message) {
      const text = `「始终允许」失败：${message}`
      try { globalThis.console?.error?.('[context-guard]', text) } catch {}
      showNotice(text)
      return new Error(text)
    }

    async function saveRiskRuleAndAllow(approval) {
      const token = riskRuleToken(approval.reason)
      if (!token) throw riskRuleFailure('审批信息里缺少放行 token，请重新触发风险命令后再试')
      const startedAt = Date.now()
      let slow = false
      const slowTimer = typeof globalThis.setTimeout === 'function'
        ? globalThis.setTimeout(() => {
          slow = true
          showNotice('「始终允许」仍在保存（已超过 2 秒），完成后会提示结果…')
        }, SLOW_NOTICE_MS)
        : undefined
      const controller = typeof globalThis.AbortController === 'function' ? new globalThis.AbortController() : null
      const timeout = controller && typeof globalThis.setTimeout === 'function'
        ? globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        : undefined
      let response
      try {
        response = await fetch(RISK_RULE_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'allow',
            token,
            ...(approval.callId === undefined ? {} : { callId: approval.callId }),
          }),
          ...(controller ? { signal: controller.signal } : {}),
        })
      } catch (error) {
        const reason = error?.name === 'AbortError'
          ? `请求超过 ${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒未返回`
          : (error?.message || String(error))
        throw riskRuleFailure(reason)
      } finally {
        if (slowTimer !== undefined && typeof globalThis.clearTimeout === 'function') globalThis.clearTimeout(slowTimer)
        if (timeout !== undefined && typeof globalThis.clearTimeout === 'function') globalThis.clearTimeout(timeout)
      }
      const body = typeof response.json === 'function' ? await response.json().catch(() => null) : null
      if (!response.ok || body?.ok !== true) {
        const detail = body?.error || 'unknown-error'
        const hint = detail === 'approval-rule-expired' ? '；审批 token 已超过 10 分钟有效期，请重新触发命令' : ''
        throw riskRuleFailure(`${detail}（HTTP ${response.status}）${hint}`)
      }
      if (slow) {
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
        showNotice(`「始终允许」已保存（耗时 ${seconds} 秒），同类命令后续会自动放行。`)
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
