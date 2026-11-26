import { runNetworkingConnectivityDnsRelaySimulation } from "../services/networking-reference-architecture.js";

const result = await runNetworkingConnectivityDnsRelaySimulation();

console.log(
  JSON.stringify(
    {
      epic: result.epic,
      scenarios: {
        crossCloudBind: result.crossCloudBind.outcome,
        domainPromotion: result.domainPromotion.validation.status,
        relay: result.relay.status,
        tenantIngress: result.tenantIngress.resolved.ok ? "resolved" : "blocked",
      },
      contracts: result.contracts.covered,
      negativeCases: {
        policyWidening: result.negative.policyWidening.effect,
        overrideConflict: result.negative.overrideConflict.code,
        splitHorizon: result.domainPromotion.negativeSplitHorizon.promotion,
        relayDenied: result.relay.deniedAttempts.map((attempt) => attempt.code),
      },
    },
    null,
    2,
  ),
);
