# dsh-loop-guard

Result-aware stuck-loop guard for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): advisory nudges plus a monotonic hard stop.

## Why

A stage that repeats the **same tool call** and keeps getting the **same result** is stuck — it burns steps (and tokens) without producing new information. This plugin ports a guard that ran for weeks in front of a multi-harness LLM gateway, where the two-stage design measurably turned aborted agentic runs into completed ones (the pattern follows OpenHands' StuckDetector lineage).

The key design decision is that **only repeats with identical results count**. Requiring result identity whitelists legitimate repeats for free, with no tool-name configuration:

- polling a job status that progresses → results differ → never triggers
- re-reading a file after an edit → result differs → never triggers
- retrying a flaky command that eventually behaves differently → never triggers

## How it relates to `@deepseek-ai/dsh-repeat-tool-reminder`

The official base bundle already ships an advisory repeat detector. This plugin is complementary, not a replacement:

|  | repeat-tool-reminder (official) | dsh-loop-guard |
|---|---|---|
| Chain identity | tool name + arguments | tool name + arguments **+ result** |
| Progressing poll loops | trigger reminders (unless excluded by pattern) | transparent, never trigger |
| Enforcement | never — advisory only, by design | denies further identical calls at the hard threshold |
| A model that ignores reminders | loops until the turn/budget dies | stopped, with corrective feedback it can act on |

Running both is fine: the reminder nudges early on argument-identical repeats; this guard only engages when the loop is provably sterile (identical results), and it is the only one of the two that can end it. The denial is a normal error **result** — the session survives and the model gets corrective feedback, which matters for frontends that treat provider-level 4xx errors as fatal.

## Install

```sh
dsh plugin --profile <name> add github:erdholion/dsh-loop-guard
```

Or from a local checkout: `dsh plugin --profile <name> add ./dsh-loop-guard`.

## Behavior

Per agent, the guard tracks the run length of consecutive tool calls with identical (name, canonically key-sorted arguments) **and** identical result content.

- **Soft stage** (run ≥ `softThreshold`, default 4): each further identical repeat injects a plugin-sourced notice after the tool result telling the model the calls are identical, that repeating will be denied at the hard threshold, and to act on what it already knows.
- **Hard stage** (run ≥ `hardThreshold`, default 8): a monotonic tool guard denies the next identical call with corrective feedback. Non-identical calls are unaffected; the chain freezes while denials repeat, so the guard stays engaged until the model changes its action.
- **Reset**: a genuine user interjection (`source.kind === 'user'`) resets the chain — repetition across a user message is not a loop. The guard's own injected notices are plugin-sourced and do not reset anything.

## Config

```yaml
- id: loop-guard
  name: dsh-loop-guard
  config:
    softThreshold: 4     # 0 disables nudges
    hardThreshold: 8     # 0 disables denial; must exceed softThreshold
    resultHashChars: 4000 # serialized-result prefix that participates in the hash
```

Invalid config (non-integer, negative, hard ≤ soft) throws at plugin load — a misconfigured guard fails loud, never silently.

## License

MIT
