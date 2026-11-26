import { runCliMcpDeveloperExperienceReference } from "../services/cli-mcp-reference.js";

const result = await runCliMcpDeveloperExperienceReference();

const summary = {
  epic: result.epic,
  mockedOnly: result.workspace.mockedOnly,
  commandParity: result.commandSurface.parity.ok,
  appDeveloperUp: result.scenarios.appDeveloper.deterministicSnapshot.up.status,
  mcpPlan: result.scenarios.mcp.plan.ok,
  mcpDeniedDeploy: result.scenarios.mcp.deniedDeploy.error?.code,
  credentialStaticKey: result.scenarios.credentials.staticKey.status,
  manifestValidation: result.scenarios.manifests.validation.ok,
  gitopsReadOnlyPlan: result.scenarios.gitops.readOnlyPlan,
  secopsDecision: result.scenarios.secops.decision.effect,
  sreStatus: result.scenarios.sre.status,
  canaryStatus: result.scenarios.canary.status.state,
  contracts: result.contracts,
};

console.log(JSON.stringify(summary, null, 2));
