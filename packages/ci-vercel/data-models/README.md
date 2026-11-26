# Vercel queue contracts

`queue.proto` records the two messages the Vercel queue accepts: a wakeup for a
previously committed delivery, and a scheduled or continuation repair request.
`queue.cue` constrains the fields used by the worker while permitting Vercel's
additional delivery metadata. Its fixtures cover both kinds and invalid input.
The `null` input used for an explicitly authenticated manual tick is a local
command, not a Vercel queue message.

`turbo_ci.proto` owns the ephemeral local Turbo CI plan. Its independent CUE
constraints and valid/invalid examples live under `turbo-ci/` to keep the queue
fixture corpus separate. See the [local runner gates](../README.md#local-runner-gates)
for the TypeScript, codegen, CLI PACT and explicit CUE fixture checks.
