/**
 * dsh-loop-guard — result-aware stuck-loop guard with a hard stop.
 *
 * A stage that repeats the SAME tool call and keeps getting the SAME result is
 * stuck: it burns steps without producing new information. Requiring identical
 * RESULTS (not just identical arguments) whitelists legitimate repeats for
 * free — polling that progresses, re-reading a file after an edit, retrying a
 * flaky command — because those produce different results and never advance
 * the chain.
 *
 * Two stages: at `softThreshold` consecutive result-identical repeats, every
 * further repeat injects a plugin-sourced corrective notice; at
 * `hardThreshold` a monotonic tool guard denies further identical calls with
 * corrective feedback. The denial is an error RESULT the model can react to —
 * the session survives.
 *
 * Complements @deepseek-ai/dsh-repeat-tool-reminder (advisory-only,
 * argument-identity chains). See README for the comparison and composition
 * guidance.
 * @module dsh-loop-guard
 */

import { createHash } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'loop-guard'
export const inject = ['tools']

/**
 * Plugin config. Misconfiguration fails loud at plugin load, never a silent
 * fall-back: a non-integer threshold, a negative value, or a hard threshold
 * at or below the soft one throws in `apply`.
 */
export const Config = z.object({
  /** Consecutive result-identical repeats before nudges start; 0 disables nudges (default 4). */
  softThreshold: z.number().default(4),
  /** Consecutive result-identical repeats before further identical calls are denied; 0 disables denial (default 8). */
  hardThreshold: z.number().default(8),
  /**
   * Characters of the serialized result content that participate in the
   * result hash (default 4000). Results that differ only beyond this prefix
   * count as identical; the cap bounds hashing cost on huge outputs.
   */
  resultHashChars: z.number().default(4000),
})

/**
 * The `{kind:'plugin'}` source stamped on every notice this guard injects —
 * the label is load-bearing (an unlabeled context would render as a user
 * prompt in derived history, and would wrongly reset repeat chains that key
 * on genuine user interjections).
 */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'loop-guard' }

/**
 * Deep key-sort of a parsed-JSON value so two argument objects that differ
 * only in property order canonicalize identically. Arguments reach the
 * pipeline as parsed JSON, so JSON's value domain is the whole input domain.
 */
function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue(value[key])
    }
    return sorted
  }
  return value
}

/** Chain key for one call: the tool name plus its canonicalized arguments. */
function callKey(exec) {
  return JSON.stringify([exec.name, JSON.stringify(sortJsonValue(exec.arguments))])
}

/** Hash of the model-visible outcome, capped at `resultHashChars` serialized characters. */
function resultHash(result, cap) {
  const serialized = JSON.stringify(
    result.isError ? ['error', result.error.message, result.content] : result.content,
  )
  return createHash('sha1').update(serialized.slice(0, cap), 'utf8').digest('hex')
}

function nudgeText(toolName, count, hardThreshold) {
  const escalation = hardThreshold > 0
    ? `After ${hardThreshold} identical repeats this exact call will be DENIED. `
    : ''
  return `Your last ${count} '${toolName}' calls were IDENTICAL, with IDENTICAL `
    + 'results. Running the same call again will not produce new information. '
    + escalation
    + 'Act on what you already know: state your conclusion, make the edit, or '
    + 'run a DIFFERENT command now.'
}

function denialReason(toolName, count) {
  return `loop-guard: '${toolName}' repeated ${count}x with identical arguments `
    + 'and identical results, so this identical call is denied — the same '
    + 'action keeps producing the same result. Change the arguments, choose a '
    + 'different tool, or conclude the task with the information you already have.'
}

/** Validate one threshold config value per the fail-loud contract. */
function validateThreshold(label, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`loop-guard: invalid ${label} ${value} — must be an integer >= 0 (0 disables the stage)`)
  }
  return value
}

/**
 * Install the guard's listeners and the monotonic pre-dispatch guard.
 * @param ctx - plugin context; registrations dispose with it.
 * @param config - validated {@link Config}, re-checked fail-loud here.
 */
export function apply(ctx, config = {}) {
  const softThreshold = validateThreshold('softThreshold', config.softThreshold ?? 4)
  const hardThreshold = validateThreshold('hardThreshold', config.hardThreshold ?? 8)
  if (hardThreshold > 0 && softThreshold > 0 && hardThreshold <= softThreshold) {
    throw new Error(`loop-guard: hardThreshold ${hardThreshold} must exceed softThreshold ${softThreshold}`)
  }
  const resultHashChars = config.resultHashChars ?? 4000
  if (!Number.isInteger(resultHashChars) || resultHashChars < 1) {
    throw new Error(`loop-guard: invalid resultHashChars ${resultHashChars} — must be an integer >= 1`)
  }

  /** One agent's chain: last (name, canonical args) key, its result hash, and the run length. */
  const chains = new WeakMap()
  /**
   * Call ids this guard denied. Their post-execute pass must not advance the
   * chain: the denial's error content differs from the looped result, so
   * counting it would reset the run and re-allow the very loop being stopped.
   */
  const denied = new Set()

  // Monotonic final policy: deny the NEXT identical call once the completed
  // run has reached the hard threshold. Returning a reason can only reduce
  // permission; a later listener cannot re-allow it.
  ctx.effect(() => ctx.tools.guard((exec) => {
    if (hardThreshold <= 0 || !exec.agent) return undefined
    const chain = chains.get(exec.agent)
    if (!chain || chain.count < hardThreshold || chain.key !== callKey(exec)) return undefined
    denied.add(exec.callId)
    return denialReason(exec.name, chain.count)
  }))

  /**
   * Advance the chain for one settled call and return the nudge to attach, if
   * the run length is in the nudge band. Counting happens in post-execute
   * because that is where the result — the half of the identity that makes
   * this guard precise — exists.
   */
  function observe(exec, result) {
    if (!exec.agent) return undefined
    if (denied.delete(exec.callId)) return undefined
    const key = callKey(exec)
    const hash = resultHash(result, resultHashChars)
    const chain = chains.get(exec.agent)
    const count = chain !== undefined && chain.key === key && chain.resultHash === hash
      ? chain.count + 1
      : 1
    chains.set(exec.agent, { key, resultHash: hash, count })
    if (softThreshold <= 0 || count < softThreshold) return undefined
    if (hardThreshold > 0 && count >= hardThreshold) return undefined
    return createUserMessage({
      content: [{ type: 'text', text: nudgeText(exec.name, count, hardThreshold) }],
      source: { ...PLUGIN_SOURCE, form: 'notice', summary: `${exec.name} × ${count} (identical results)` },
    })
  }

  // Observe-and-enrich: DELEGATE first so the hash covers the outcome later
  // listeners settled on being blocked or accepted, then fold the nudge onto
  // whichever decision came back — additionalContexts rides both variants.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    const nudge = observe(exec, result)
    if (!nudge) return downstream
    return {
      ...downstream,
      additionalContexts: [nudge, ...downstream.additionalContexts ?? []],
    }
  })

  // A user interjection changes the context; repetition across it is not a
  // loop. Plugin-sourced notices (including this guard's own nudges) do not
  // reset — only a genuine user message does.
  ctx.on('agent/pre-step', ({ agent, messages }, next) => {
    if (messages.some(message => message.source.kind === 'user')) chains.delete(agent)
    return next()
  })
}
