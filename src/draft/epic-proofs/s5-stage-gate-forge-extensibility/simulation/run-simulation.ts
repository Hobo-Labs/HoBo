import { runS5StageGateForgeDrill } from "../services/s5-stage-gate-reference.js";

const result = await runS5StageGateForgeDrill();

console.log(JSON.stringify({
  epic: result.epic,
  forge: {
    command: result.forge.command,
    outcome: result.forge.outcome,
    registryEventType: result.forge.registryEventType,
  },
  registry: {
    installOk: result.registry.installOk,
    availableToMatching: result.registry.availableToMatching,
    selectedByMatching: result.registry.selectedByMatching,
  },
  bindleDeploy: {
    outcome: result.bindleDeploy.outcome,
    resourceStatus: result.bindleDeploy.resourceStatus,
  },
  stubImpl: {
    traceReplay: result.stubImpl.traceReplay,
    evalGate: result.stubImpl.evalGate,
    promotionOutcome: result.stubImpl.promotionOutcome,
  },
  liveFix: {
    status: result.liveFix.status,
    autoRollback: result.liveFix.autoRollback,
    regressionTestRetained: result.liveFix.regressionTestRetained,
  },
  adversarial: result.adversarial,
  contracts: result.contracts,
}, null, 2));
