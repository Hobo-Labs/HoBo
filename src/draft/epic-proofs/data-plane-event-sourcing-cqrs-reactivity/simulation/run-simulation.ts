import { runDataPlaneReferenceSimulation } from "../services/data-plane-reference-architecture.js";

const result = await runDataPlaneReferenceSimulation();

console.log(
  JSON.stringify(
    {
      epic: result.epic,
      scenarios: {
        orderFlow: result.orderFlow.outcome,
        projectionSinks: [result.sinks.relational.status, result.sinks.document.status],
        search: result.search.fullText.hits.map((hit) => hit.id),
        poisonEvent: result.adversarial.poisonEvent.outcome,
        cryptoShred: result.adversarial.cryptoShred.tombstoneVisible,
      },
      contracts: result.contracts.covered,
      negativeCases: {
        projectionLag: result.adversarial.projectionLag.eventType,
        snapshotDivergence: result.adversarial.snapshotDivergence.recoveredBy,
        rawWriteBlocked: result.rawEscapeHatch.writeBlocked,
      },
    },
    null,
    2,
  ),
);
