import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  activeFleetRun,
  latestAssistantText,
  nextRunNumber,
  parseReview,
  resolveConfig,
  reviewsForRun,
  runTask,
} from '../src/index.ts'

/** One logged event with the fields the folds read. */
function event(type: SessionEvent['type'], data: Record<string, unknown>, extra: Record<string, unknown> = {}): SessionEvent {
  return { type, seq: 1, time: 1, data, ...extra } as unknown as SessionEvent
}

const userMessage = (text: string): SessionEvent => event('user/message', {
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

describe('resolveConfig', () => {
  const base = {
    roles: [{ id: 'reviewer', instructions: 'Review carefully.' }],
    maxRounds: 2,
    maxTranscriptChars: 8000,
  }
  const reviewer = base.roles[0]!

  it('accepts a valid config with default-routed roles', () => {
    expect(resolveConfig({ ...base })).toEqual({ ...base })
  })

  it('rejects empty roles, duplicate ids, and mixed provider/model pairs', () => {
    expect(() => resolveConfig({ ...base, roles: [] })).toThrow('non-empty array')
    expect(() => resolveConfig({ ...base, roles: [reviewer, { id: 'reviewer', instructions: 'x' }] }))
      .toThrow('repeats role id')
    expect(() => resolveConfig({ ...base, roles: [{ id: 'r', instructions: 'x', model: 'm' }] }))
      .toThrow('provider and model together')
  })

  it('rejects bad maxRounds and maxTranscriptChars', () => {
    expect(() => resolveConfig({ ...base, maxRounds: 0 })).toThrow('positive integer')
    expect(() => resolveConfig({ ...base, maxRounds: 1.5 })).toThrow('positive integer')
    expect(() => resolveConfig({ ...base, maxTranscriptChars: 0 })).toThrow('positive number')
  })
})

describe('fleet folds', () => {
  it('activeFleetRun tracks the latest run until an end closes it', () => {
    const events = [
      event('fleet/run', { id: '1', roles: 1 }),
      event('fleet/run', { id: '2', roles: 2 }),
      event('fleet/end', { id: '1', reason: 'clean' }),
    ]
    expect(activeFleetRun(events)).toEqual({ id: '2', roles: 2 })
    expect(activeFleetRun([...events, event('fleet/end', { id: '2', reason: 'clean' })])).toBeUndefined()
  })

  it('reviewsForRun counts only the named run', () => {
    const events = [
      event('fleet/review', { id: '1', role: 'a', verdict: 'fix', feedback: 'x', chars: 1 }),
      event('fleet/review', { id: '2', role: 'a', verdict: 'pass', feedback: '', chars: 0 }),
    ]
    expect(reviewsForRun(events, '1')).toBe(1)
    expect(reviewsForRun(events, '2')).toBe(1)
    expect(reviewsForRun(events, '3')).toBe(0)
  })

  it('runTask takes the first user message after the run, else the latest', () => {
    const events = [
      userMessage('before'),
      event('fleet/run', { id: '1', roles: 1 }),
      userMessage('the task'),
      userMessage('another message'),
    ]
    expect(runTask(events, '1')).toBe('the task')
    expect(runTask([event('fleet/run', { id: '2', roles: 1 })], '2')).toBe('')
  })

  it('latestAssistantText caps the last assistant message', () => {
    const events = [event('assistant/message', {
      message: { content: [{ type: 'text', text: 'hello world' }] },
    })]
    expect(latestAssistantText(events, 5)).toBe('hello')
    expect(latestAssistantText(events, 100)).toBe('hello world')
    expect(latestAssistantText([], 100)).toBe('')
  })

  it('nextRunNumber counts prior runs', () => {
    const events = [
      event('fleet/run', { id: '1', roles: 1 }),
      event('fleet/run', { id: '2', roles: 1 }),
    ]
    expect(nextRunNumber(events)).toBe(3)
    expect(nextRunNumber([])).toBe(1)
  })
})

describe('parseReview', () => {
  it('parses pass and fix verdicts', () => {
    expect(parseReview('{"verdict":"pass","feedback":""}')).toEqual({ verdict: 'pass', feedback: '' })
    expect(parseReview('prefix {"verdict":"fix","feedback":"add tests"} suffix'))
      .toEqual({ verdict: 'fix', feedback: 'add tests' })
  })

  it('treats unparseable output as a fix carrying the raw text', () => {
    expect(parseReview('looks fine to me')).toEqual({ verdict: 'fix', feedback: 'looks fine to me' })
    expect(parseReview('{"verdict":"unknown"}')).toEqual({ verdict: 'fix', feedback: '(no feedback provided)' })
    expect(parseReview('')).toEqual({ verdict: 'fix', feedback: '(no feedback provided)' })
  })
})

describe('session message text', () => {
  it('createUserMessage builds a steerable user-role message', () => {
    const session = Session.create(SessionId('fleet-msg'))
    const message = createUserMessage({
      content: [{ type: 'text', text: 'task' }],
      source: { kind: 'user' },
    })
    session.append('user/message', message, { surfaceOp: 'append' })
    expect(session.events.at(-1)?.type).toBe('user/message')
  })
})
