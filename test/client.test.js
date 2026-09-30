import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

function createReactHarness() {
  const states = []
  const effectDeps = []
  let stateCursor = 0
  let effectCursor = 0
  let pendingEffects = []
  let dirty = false

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return {
        type,
        props: {
          ...(props ?? {}),
          children,
        },
      }
    },
    useState(initial) {
      const index = stateCursor
      stateCursor += 1
      if (!(index in states)) {
        states[index] = typeof initial === 'function' ? initial() : initial
      }
      return [
        states[index],
        (next) => {
          const value = typeof next === 'function' ? next(states[index]) : next
          if (!Object.is(value, states[index])) {
            states[index] = value
            dirty = true
          }
        },
      ]
    },
    useEffect(effect, deps) {
      const index = effectCursor
      effectCursor += 1
      const previous = effectDeps[index]
      const changed = previous === undefined
        || deps === undefined
        || deps.length !== previous.length
        || deps.some((value, depIndex) => !Object.is(value, previous[depIndex]))
      if (changed) {
        effectDeps[index] = deps
        pendingEffects.push(effect)
      }
    },
  }

  function render(component, props) {
    let tree
    for (let pass = 0; pass < 10; pass += 1) {
      dirty = false
      stateCursor = 0
      effectCursor = 0
      pendingEffects = []
      tree = component(props)
      const effects = pendingEffects
      pendingEffects = []
      for (const effect of effects) effect()
      if (!dirty) return tree
    }
    throw new Error('test React harness did not settle')
  }

  return { React, render }
}

function loadPromptModeForm() {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const harness = createReactHarness()
  let definition
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load(value) {
          definition = value
        },
      },
    },
  })

  assert.ok(definition)
  const plugin = definition.factory((request) => {
    assert.equal(request, 'react')
    return harness.React
  })

  let registration
  const ctx = {
    effect(factory) {
      return factory()
    },
    locale: {
      register() {
        return () => {}
      },
    },
    slots: {
      inject(name, factory) {
        assert.equal(name, 'plugins.row.config')
        return factory()
      },
      register(options, component) {
        registration = { options, component }
        return () => {}
      },
    },
  }
  plugin.apply(ctx)

  assert.ok(registration)
  assert.equal(registration.options.key, 'dsh-budget-tracker#budget-tracker')
  return { ...harness, component: registration.component }
}

function findAll(node, predicate, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found)
    return found
  }
  if (node === null || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  findAll(node.props?.children, predicate, found)
  return found
}

function textContent(node) {
  if (Array.isArray(node)) return node.map(textContent).join('')
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return textContent(node.props?.children)
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function readyState(promptMode, {
  revision = 1,
  user = {},
  writable = true,
} = {}) {
  return {
    status: 'ready',
    value: { promptMode },
    base: { promptMode: 'semantic' },
    user,
    revision,
    writable,
    mode: 'host',
  }
}

test('browser prompt mode form saves a staged mode with the current revision', async () => {
  const { component, render } = loadPromptModeForm()
  const calls = []
  const form = {
    state: readyState('semantic', { revision: 7 }),
    mutate: async (...args) => {
      calls.push(args)
      return true
    },
  }
  const props = { t: key => key, view: 'page', form }

  let tree = render(component, props)
  const fieldset = findAll(tree, node => node.type === 'fieldset')[0]
  const heading = findAll(tree, node => node.type === 'h4')[0]
  assert.equal(fieldset.props['aria-labelledby'], heading.props.id)

  const planning = findAll(
    tree,
    node => node.type === 'input' && node.props.value === 'planning',
  )[0]
  planning.props.onChange()

  tree = render(component, props)
  const formNode = findAll(tree, node => node.type === 'form')[0]
  let prevented = false
  formNode.props.onSubmit({ preventDefault: () => { prevented = true } })

  assert.equal(prevented, true)
  assert.deepEqual(plain(calls), [[
    [{ op: 'set', path: ['promptMode'], value: 'planning' }],
    7,
  ]])

  await Promise.resolve()
  await Promise.resolve()
  tree = render(component, props)
  assert.equal(
    findAll(tree, node => node.type === 'p' && node.props.role === 'status')
      .some(node => textContent(node) === 'saved'),
    true,
  )

  form.state = readyState('planning', {
    revision: 8,
    user: { promptMode: 'planning' },
  })
  tree = render(component, props)
  assert.equal(
    findAll(tree, node => node.type === 'p' && node.props.role === 'status')
      .some(node => textContent(node) === 'saved'),
    true,
  )
})

test('browser prompt mode form resets the profile override with the current revision', () => {
  const { component, render } = loadPromptModeForm()
  const calls = []
  const form = {
    state: readyState('planning', {
      revision: 11,
      user: { promptMode: 'planning' },
    }),
    mutate: (...args) => {
      calls.push(args)
      return Promise.resolve(true)
    },
  }

  const tree = render(component, { t: key => key, view: 'page', form })
  const reset = findAll(
    tree,
    node => node.type === 'button'
      && node.props.type === 'button'
      && textContent(node) === 'reset',
  )[0]
  assert.ok(reset)
  reset.props.onClick()

  assert.deepEqual(plain(calls), [[
    [{ op: 'unset', path: ['promptMode'] }],
    11,
  ]])
})
