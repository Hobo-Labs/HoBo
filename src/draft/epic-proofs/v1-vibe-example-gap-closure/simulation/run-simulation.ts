import { evaluateVibeGapClosure, rejectVibeScopeCreep } from "../src/vibe-gap-closure.js";

const result = evaluateVibeGapClosure();
const denials = rejectVibeScopeCreep([
  "Ship the production CLI implementation for the quickstart.",
  "Implement the production UI for the vibe examples.",
  "Use live customer data for the support case prototype.",
  "Publish final launch claims from the launch demo storyboard.",
]);

console.log(
  JSON.stringify(
    {
      ok: result.ok,
      parentIssue: result.summary.parentIssue,
      childCount: result.summary.childCount,
      dxBackbone: result.summary.dxBackbone,
      phases: result.summary.phases,
      projects: result.summary.projects,
      contracts: result.summary.contracts.covered,
      unblockOutcome: result.summary.unblockOutcome,
      scopeDenials: denials,
    },
    null,
    2,
  ),
);
