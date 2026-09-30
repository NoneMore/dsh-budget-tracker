/** Browser configuration page for dsh-budget-tracker. */
window.__ModuleLoader__.load({
  id: 'dsh-budget-tracker',
  factory(require) {
    const React = require('react')
    const { useEffect, useState } = React

    const NS = 'budgetTracker'
    const ROW_KEY = 'dsh-budget-tracker#budget-tracker'
    const DEFAULT_MODE = 'semantic'
    const MODES = ['none', 'semantic', 'planning', 'behavioral']

    const dictionaries = {
      en: {
        summary: 'Choose how strongly the model should react to the remaining context budget.',
        intro: 'Prompt guidance',
        description: 'Controls the static system-prompt guidance attached to context_remaining. The budget calculation and compaction policy do not change.',
        loading: 'Loading configuration…',
        unavailable: 'Configuration is unavailable in this profile.',
        readonly: 'This profile does not allow configuration writes.',
        save: 'Save',
        saving: 'Saving…',
        reset: 'Reset to inherited',
        resetting: 'Resetting…',
        saved: 'Saved.',
        rejected: 'The configuration changed elsewhere or could not be written. Review the current value and try again.',
        failed: 'Could not save the configuration.',
        overridden: 'Profile override',
        inherited: 'Inherited',
        modeNone: 'None',
        modeNoneDesc: 'Do not add static guidance. The dynamic context_remaining snapshot is still emitted.',
        modeSemantic: 'Semantic',
        modeSemanticDesc: 'Explain what context_remaining means and distinguish it from the absolute context-window remainder.',
        modePlanning: 'Planning',
        modePlanningDesc: 'Also ask the model to use context_remaining as a context-pressure signal when planning its response.',
        modeBehavioral: 'Behavioral',
        modeBehavioralDesc: 'Also guide the model to actively limit avoidable context growth as the remaining budget decreases.',
      },
      zh: {
        summary: '选择模型应以多强的程度响应剩余上下文预算。',
        intro: 'Prompt 引导模式',
        description: '控制写入系统提示词的 context_remaining 引导。预算计算方式和压缩策略不会因此改变。',
        loading: '正在加载配置…',
        unavailable: '当前配置文件中无法编辑此项。',
        readonly: '当前配置文件不允许写入配置。',
        save: '保存',
        saving: '正在保存…',
        reset: '恢复继承值',
        resetting: '正在恢复…',
        saved: '已保存。',
        rejected: '配置可能已在其他位置发生变化，或当前写入被拒绝。请检查当前值后重试。',
        failed: '保存配置失败。',
        overridden: '配置文件覆盖',
        inherited: '继承值',
        modeNone: 'None',
        modeNoneDesc: '不加入静态引导；动态 context_remaining 快照仍会正常注入。',
        modeSemantic: 'Semantic',
        modeSemanticDesc: '解释 context_remaining 的含义，并明确它不是模型绝对上下文窗口的剩余量。',
        modePlanning: 'Planning',
        modePlanningDesc: '在语义说明之外，引导模型把 context_remaining 作为规划回答时的上下文压力信号。',
        modeBehavioral: 'Behavioral',
        modeBehavioralDesc: '进一步引导模型在剩余预算降低时主动减少不必要的上下文增长。',
      },
    }

    const modeCopy = {
      none: ['modeNone', 'modeNoneDesc'],
      semantic: ['modeSemantic', 'modeSemanticDesc'],
      planning: ['modePlanning', 'modePlanningDesc'],
      behavioral: ['modeBehavioral', 'modeBehavioralDesc'],
    }

    const css = `
      .dsh-budget-tracker-config {
        display: grid;
        gap: 16px;
        color: var(--dsw-alias-label-primary);
      }
      .dsh-budget-tracker-config__head {
        display: grid;
        gap: 6px;
      }
      .dsh-budget-tracker-config__title {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
      }
      .dsh-budget-tracker-config__description,
      .dsh-budget-tracker-config__status {
        margin: 0;
        color: var(--dsw-alias-label-secondary);
        font-size: 12px;
        line-height: 1.55;
      }
      .dsh-budget-tracker-config__modes {
        display: grid;
        gap: 8px;
        margin: 0;
        padding: 0;
        border: 0;
      }
      .dsh-budget-tracker-config__option {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 10px;
        align-items: start;
        padding: 12px;
        border: 0.5px solid var(--dsw-alias-border-l4);
        border-radius: 10px;
        background: var(--dsw-alias-bg-layer-2);
        cursor: pointer;
      }
      .dsh-budget-tracker-config__option[data-selected="true"] {
        border-color: var(--dsw-alias-state-business-primary);
        box-shadow: inset 0 0 0 0.5px var(--dsw-alias-state-business-primary);
        background: var(--dsw-alias-bg-layer-3);
      }
      .dsh-budget-tracker-config__option:focus-within {
        outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: 1px;
      }
      .dsh-budget-tracker-config__radio {
        margin-top: 2px;
        accent-color: var(--dsw-alias-brand-primary);
      }
      .dsh-budget-tracker-config__option-text {
        display: grid;
        gap: 3px;
      }
      .dsh-budget-tracker-config__option-title {
        font-size: 13px;
        font-weight: 600;
      }
      .dsh-budget-tracker-config__option-description {
        color: var(--dsw-alias-label-tertiary);
        font-size: 12px;
        line-height: 1.5;
      }
      .dsh-budget-tracker-config__meta {
        display: flex;
        gap: 8px;
        align-items: center;
        min-height: 20px;
        color: var(--dsw-alias-label-tertiary);
        font-size: 11px;
      }
      .dsh-budget-tracker-config__badge {
        display: inline-flex;
        align-items: center;
        min-height: 20px;
        padding: 0 7px;
        border-radius: 999px;
        border: 0.5px solid var(--dsw-alias-border-l3);
        background: var(--dsw-alias-bg-layer-3);
        color: var(--dsw-alias-label-secondary);
      }
      .dsh-budget-tracker-config__actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      .dsh-budget-tracker-config__button {
        min-height: 30px;
        padding: 0 12px;
        border-radius: 7px;
        border: 0.5px solid var(--dsw-alias-border-l3);
        background: var(--dsw-alias-bg-layer-3);
        color: var(--dsw-alias-label-primary);
        font: inherit;
        cursor: pointer;
      }
      .dsh-budget-tracker-config__button[data-primary="true"] {
        border-color: var(--dsw-alias-state-business-primary);
        box-shadow: inset 0 0 0 0.5px var(--dsw-alias-state-business-primary);
      }
      .dsh-budget-tracker-config__button:hover:not(:disabled) {
        background: var(--dsw-alias-interactive-bg-hover);
      }
      .dsh-budget-tracker-config__button:focus-visible {
        outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: 1px;
      }
      .dsh-budget-tracker-config__button:disabled {
        cursor: default;
        opacity: 0.55;
      }
      .dsh-budget-tracker-config__status[data-tone="error"] {
        color: var(--dsw-alias-state-error-primary);
      }
    `

    function hasPromptOverride(user) {
      return user !== null
        && typeof user === 'object'
        && !Array.isArray(user)
        && Object.prototype.hasOwnProperty.call(user, 'promptMode')
    }

    function PromptModeForm({ t, view, form }) {
      const state = form?.state
      const effective = state?.value?.promptMode
      const current = MODES.includes(effective) ? effective : DEFAULT_MODE
      const [draft, setDraft] = useState(current)
      const [busy, setBusy] = useState(null)
      const [notice, setNotice] = useState(null)

      useEffect(() => {
        setDraft(current)
        setNotice(null)
      }, [current, state?.revision])

      if (view === 'summary') return t('summary')

      const ready = state?.status === 'ready'
      const writable = ready && state.writable === true
      const overridden = ready && hasPromptOverride(state.user)
      const dirty = ready && draft !== current

      const mutate = async (ops, kind) => {
        if (!form || !ready || !writable || busy !== null) return
        setBusy(kind)
        setNotice(null)
        try {
          const accepted = await form.mutate(ops, state.revision)
          setNotice(accepted ? 'saved' : 'rejected')
        } catch {
          setNotice('failed')
        } finally {
          setBusy(null)
        }
      }

      const message = state === undefined
        ? 'unavailable'
        : state.status === 'loading'
          ? 'loading'
          : state.status === 'unavailable'
            ? 'unavailable'
            : !state.writable
              ? 'readonly'
              : notice

      return React.createElement(
        React.Fragment,
        null,
        React.createElement('style', null, css),
        React.createElement(
          'form',
          {
            className: 'dsh-budget-tracker-config',
            'data-budget-tracker-config': '',
            onSubmit: (event) => {
              event.preventDefault()
              void mutate([{ op: 'set', path: ['promptMode'], value: draft }], 'save')
            },
          },
          React.createElement(
            'div',
            { className: 'dsh-budget-tracker-config__head' },
            React.createElement('h4', { className: 'dsh-budget-tracker-config__title' }, t('intro')),
            React.createElement('p', { className: 'dsh-budget-tracker-config__description' }, t('description')),
          ),
          ready
            ? React.createElement(
              'fieldset',
              { className: 'dsh-budget-tracker-config__modes', disabled: !writable || busy !== null },
              ...MODES.map((mode) => {
                const [titleKey, descriptionKey] = modeCopy[mode]
                return React.createElement(
                  'label',
                  {
                    key: mode,
                    className: 'dsh-budget-tracker-config__option',
                    'data-selected': String(draft === mode),
                    'data-prompt-mode': mode,
                  },
                  React.createElement('input', {
                    className: 'dsh-budget-tracker-config__radio',
                    type: 'radio',
                    name: 'promptMode',
                    value: mode,
                    checked: draft === mode,
                    onChange: () => { setDraft(mode); setNotice(null) },
                  }),
                  React.createElement(
                    'span',
                    { className: 'dsh-budget-tracker-config__option-text' },
                    React.createElement('span', { className: 'dsh-budget-tracker-config__option-title' }, t(titleKey)),
                    React.createElement('span', { className: 'dsh-budget-tracker-config__option-description' }, t(descriptionKey)),
                  ),
                )
              }),
            )
            : null,
          ready
            ? React.createElement(
              'div',
              { className: 'dsh-budget-tracker-config__meta' },
              React.createElement(
                'span',
                { className: 'dsh-budget-tracker-config__badge' },
                t(overridden ? 'overridden' : 'inherited'),
              ),
            )
            : null,
          React.createElement(
            'div',
            { className: 'dsh-budget-tracker-config__actions' },
            ready
              ? React.createElement(
                'button',
                {
                  className: 'dsh-budget-tracker-config__button',
                  'data-primary': 'true',
                  type: 'submit',
                  disabled: !writable || !dirty || busy !== null,
                },
                t(busy === 'save' ? 'saving' : 'save'),
              )
              : null,
            ready && overridden
              ? React.createElement(
                'button',
                {
                  className: 'dsh-budget-tracker-config__button',
                  type: 'button',
                  disabled: !writable || busy !== null,
                  onClick: () => { void mutate([{ op: 'unset', path: ['promptMode'] }], 'reset') },
                },
                t(busy === 'reset' ? 'resetting' : 'reset'),
              )
              : null,
            message === null
              ? null
              : React.createElement(
                'p',
                {
                  className: 'dsh-budget-tracker-config__status',
                  role: message === 'failed' || message === 'rejected' ? 'alert' : 'status',
                  'data-tone': message === 'failed' || message === 'rejected' ? 'error' : 'neutral',
                },
                t(message),
              ),
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries))
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_KEY,
          locale: NS,
        }, PromptModeForm))
      },
    }
  },
})
