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
    const REASON_DIALOG_ID = 'context-guard-reason-dialog'
    const REASON_MAX = 200
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
        return '点击「始终允许」会先要求填写放行原因，并把原因作为规则标记保存；随后把命令解析成安全类规则：同一项目前缀下清理构建产物（node_modules、dist、build、.cache 等）会自动放行；当前目录 `.tmp*` 下的简单 rm 只在当前目录自动放行；未知链接只放行该主机；无法证明为安全类时只记住完全相同的命令。勾选「仅记住这条完整命令」可跳过类别放宽。不会按高风险代码全量放行。'
      }
      return '“Always allow” first asks for a reason and stores it as the rule label; it then parses the command into a safe-class rule: cleaning build artifacts (node_modules, dist, build, .cache, …) under the same project prefix is auto-allowed; a simple rm under `.tmp*` is auto-allowed only in the current directory; unknown links allow only that host; when no safe class can be proven, only the exact command is remembered. Tick “remember only this exact command” to skip category widening. High-risk codes are never wildcarded.'
    }

    /** 把落库的规则种类翻成一句人话，让用户知道这次放宽了什么。 */
    function describeRuleKinds(kinds) {
      const names = {
        host: '仅放行这些主机',
        command: '仅这条完整命令',
        'artifact-rm': '同一项目前缀下的构建产物清理',
        'artifact-find': '同一项目前缀下的产物查找删除',
        'temp-rm': '当前目录下 `.tmp*` 的临时清理',
      }
      const labels = kinds.map(kind => names[kind]).filter(Boolean)
      return labels.length > 0 ? labels.join('、') : '已保存'
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

    /** 「始终允许」前询问放行原因；取消/关闭返回 null。 */
    function askRiskReason() {
      const doc = globalThis.document
      if (!doc?.body || typeof doc.createElement !== 'function') return Promise.resolve(null)
      if (doc.getElementById?.(REASON_DIALOG_ID)) return Promise.resolve(null)
      return new Promise(resolve => {
        const mask = doc.createElement('div')
        mask.id = REASON_DIALOG_ID
        mask.setAttribute('role', 'dialog')
        mask.setAttribute('aria-modal', 'true')
        mask.setAttribute('aria-label', '填写放行原因')
        mask.style.cssText = 'position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.55)'
        const panel = doc.createElement('div')
        panel.style.cssText = 'width:min(440px,92vw);box-sizing:border-box;padding:18px 20px;border-radius:12px;background:#111827;color:#f9fafb;font-size:13px;line-height:1.5;box-shadow:0 12px 40px rgba(0,0,0,.45)'
        const title = doc.createElement('div')
        title.textContent = '填写放行原因'
        title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:6px'
        const help = doc.createElement('div')
        help.textContent = '原因会作为规则标记保存到 risk-allow.json，便于以后复核这条「始终允许」；默认按安全类别收窄，不会整条命令全量放行。'
        help.style.cssText = 'color:#9ca3af;margin-bottom:12px'
        const input = doc.createElement('input')
        input.type = 'text'
        input.maxLength = REASON_MAX
        input.placeholder = '例如：清理构建产物，准备重新打包'
        input.setAttribute('aria-label', '放行原因（必填）')
        input.style.cssText = 'width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid #374151;background:#0b1220;color:#f9fafb;font-size:13px;outline:none'
        const hint = doc.createElement('div')
        hint.textContent = `必填，最多 ${REASON_MAX} 字`
        hint.style.cssText = 'color:#9ca3af;margin:6px 0 14px'
        const onlyLabel = doc.createElement('label')
        onlyLabel.style.cssText = 'display:flex;align-items:center;gap:8px;color:#d1d5db;margin:0 0 16px;cursor:pointer'
        const onlyBox = doc.createElement('input')
        onlyBox.type = 'checkbox'
        onlyBox.style.cssText = 'margin:0;accent-color:#2563eb'
        const onlyText = doc.createElement('span')
        onlyText.textContent = '仅记住这条完整命令（不按类别放宽）'
        onlyLabel.appendChild(onlyBox)
        onlyLabel.appendChild(onlyText)
        const actions = doc.createElement('div')
        actions.style.cssText = 'display:flex;justify-content:flex-end;gap:10px'
        const cancel = doc.createElement('button')
        cancel.type = 'button'
        cancel.textContent = '取消'
        cancel.style.cssText = 'padding:7px 14px;border-radius:8px;border:1px solid #374151;background:transparent;color:#e5e7eb;cursor:pointer;font-size:13px'
        const save = doc.createElement('button')
        save.type = 'button'
        save.textContent = '保存并允许'
        save.style.cssText = 'padding:7px 14px;border-radius:8px;border:0;background:#2563eb;color:#fff;cursor:pointer;font-size:13px;font-weight:600'
        let settled = false
        const finish = (value) => {
          if (settled) return
          settled = true
          if (typeof mask.remove === 'function') mask.remove()
          else mask.parentNode?.removeChild?.(mask)
          resolve(value)
        }
        const submit = () => {
          const text = String(input.value || '').replace(/\s+/g, ' ').trim()
          if (!text) {
            hint.textContent = '请填写原因后再允许'
            hint.style.color = '#fca5a5'
            input.focus?.()
            return
          }
          finish({ reason: text.slice(0, REASON_MAX), scope: onlyBox.checked ? 'command' : 'auto' })
        }
        cancel.addEventListener('click', () => finish(null))
        save.addEventListener('click', submit)
        input.addEventListener('keydown', event => {
          if (event?.key === 'Enter') {
            event.preventDefault?.()
            submit()
          } else if (event?.key === 'Escape') {
            finish(null)
          }
        })
        panel.appendChild(title)
        panel.appendChild(help)
        panel.appendChild(input)
        panel.appendChild(hint)
        panel.appendChild(onlyLabel)
        panel.appendChild(actions)
        actions.appendChild(cancel)
        actions.appendChild(save)
        mask.appendChild(panel)
        doc.body.appendChild(mask)
        input.focus?.()
      })
    }

    /** 失败必须可见：提示 + 控制台，错误码用于定位 Host 侧原因。 */
    function riskRuleFailure(message) {
      const text = `「始终允许」失败：${message}`
      try { globalThis.console?.error?.('[context-guard]', text) } catch {}
      showNotice(text)
      return new Error(text)
    }

    async function saveRiskRuleAndAllow(approval, choice) {
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
            reason: choice.reason,
            ...(choice.scope === 'command' ? { scope: 'command' } : {}),
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
      const kinds = Array.isArray(body.rules) ? [...new Set(body.rules.map(rule => rule.kind))] : []
      const summary = describeRuleKinds(kinds)
      if (slow) {
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
        showNotice(`「始终允许」已保存（耗时 ${seconds} 秒）：${summary}。`)
      } else {
        showNotice(`「始终允许」已保存：${summary}。`)
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
        onAlways: async () => {
          const choice = await askRiskReason()
          if (choice === null) return
          await saveRiskRuleAndAllow(approval, choice)
        },
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
