import { Context, type Plugin } from '@deepseek-ai/cordis'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as agent from './agent.ts'
import * as builtins from './builtins.ts'
import * as llm from './scripted-llm.ts'
import * as tools from './tools.ts'

/** Mount one sample plugin the way the loader mounts its module object. */
function pluginOf(mod: Plugin.Object): Plugin.Object {
  const plugin: Plugin.Object = { apply: mod.apply }
  if (mod.name !== undefined) plugin.name = mod.name
  if (mod.inject !== undefined) plugin.inject = mod.inject
  if (mod.Config !== undefined) plugin.Config = mod.Config
  return plugin
}

/** Boot the loop in process. `withTools` omits `add` and `echo` when false. */
async function boot(maxSteps: number, withTools: boolean) {
  const ctx = new Context()
  await ctx.plugin(pluginOf(tools))
  await ctx.plugin(pluginOf(llm))
  await ctx.plugin(pluginOf(agent), { maxSteps })
  if (withTools) await ctx.plugin(pluginOf(builtins))
  return ctx
}

test('add runs the tool and returns the sum', async () => {
  const ctx = await boot(4, true)
  const answer = await ctx.agent.run('add 2 and 3')
  if (answer !== '5') throw new Error(`expected 5, got ${answer}`)
})

test('echo returns the requested text', async () => {
  const ctx = await boot(4, true)
  const answer = await ctx.agent.run('echo hello')
  if (answer !== 'hello') throw new Error(`expected hello, got ${answer}`)
})

test('an ordinary sentence gets the usage line', async () => {
  const ctx = await boot(4, true)
  const answer = await ctx.agent.run('what can you do')
  if (answer !== 'Ask me to add two numbers, or to echo some text.') {
    throw new Error(`unexpected answer: ${answer}`)
  }
})

test('a missing tool becomes text for the model', async () => {
  const ctx = await boot(4, false)
  const answer = await ctx.agent.run('add 2 and 3')
  if (answer !== 'Ask me to add two numbers, or to echo some text.') {
    throw new Error(`unexpected answer: ${answer}`)
  }
})

test('maxSteps stops a turn that is still calling tools', async () => {
  const ctx = await boot(1, true)
  try {
    await ctx.agent.run('add 2 and 3')
  } catch (error) {
    if (error instanceof Error && error.message === 'agent stopped after 1 steps') return
    throw error
  }
  throw new Error('expected the step limit to reject')
})

test('unloading the tool plugin removes its tools', async () => {
  const ctx = await boot(4, false)
  const fiber = ctx.plugin(pluginOf(builtins))
  await fiber
  await ctx.tools.execute({ id: 'probe', name: 'add', arguments: { a: 1, b: 1 } }).then((output) => {
    if (output !== '2') throw new Error(`expected 2, got ${output}`)
  })
  await fiber.dispose()
  const output = await ctx.tools.execute({ id: 'probe', name: 'add', arguments: { a: 1, b: 1 } })
  if (output !== 'Unknown tool: add') throw new Error(`expected removal, got ${output}`)
})

/** Run `cordis.yml` through the Cordis launcher with `args` as the prompt. */
function launch(args: readonly string[]) {
  const harness = fileURLToPath(new URL('..', import.meta.url))
  const bin = fileURLToPath(new URL('../../vendor/cordis/bin.js', import.meta.url))
  const env = { ...process.env }
  delete env.MINI_PROMPT
  return spawnSync(process.execPath, ['--import', 'tsx', bin, ...args], {
    cwd: harness,
    env,
    encoding: 'utf8',
    timeout: 15_000,
  })
}

test('cordis.yml rejects a missing prompt', () => {
  const result = launch([])
  if (result.status !== 1) throw new Error(`exit ${String(result.status)}\n${result.stderr}`)
  if (!result.stderr.includes('usage: node --import tsx ../vendor/cordis/bin.js <prompt>')) {
    throw new Error(`missing usage\n${result.stderr}`)
  }
})

test('cordis.yml answers add 2 and 3', () => {
  const result = launch(['add', '2', 'and', '3'])
  if (result.status !== 0) {
    throw new Error(`exit ${String(result.status)}\n${result.stdout}\n${result.stderr}`)
  }
  const expected = [
    'step 1: add {"a":2,"b":3}',
    'tool add -> 5',
    'step 2: 5',
    '5',
  ]
  for (const line of expected) {
    if (!result.stdout.includes(line)) throw new Error(`missing ${line}\n${result.stdout}`)
  }
})
