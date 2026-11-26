import { runPortabilityRegistrySimulation } from "../services/portability-registry-reference.js";

const result = await runPortabilityRegistrySimulation();

console.log(JSON.stringify({
  epic: result.epic,
  install: {
    ok: result.install.ok,
    availableToMatching: result.install.availableToMatching,
    selectedByMatching: result.install.selectedByMatching,
  },
  resolution: {
    ok: result.resolution.ok,
    pins: result.resolution.pins,
  },
  yankedCanDeploy: result.yankedCanDeploy,
  offlineImport: {
    ok: result.offlineImport.ok,
    egressAttempts: result.offlineImport.egressAttempts,
    eventType: result.offlineImport.event.type,
  },
  contracts: result.contracts,
}, null, 2));
