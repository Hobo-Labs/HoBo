import { runGenerationPipelineTrainingSafetySimulation } from "../services/generation-reference-architecture.js";

const result = await runGenerationPipelineTrainingSafetySimulation();

console.log(
  JSON.stringify(
    {
      epic: result.epic,
      scenarios: {
        coldStartProvider: result.coldStart.outcome,
        trainingPromotion: result.training.promotion.outcome,
        liveFixGate: result.liveFix.decision.outcome,
        crossLayerPropagation: result.crossLayer.outcome,
      },
      contracts: result.contracts.covered,
      negativeCases: {
        nonConverging: result.negative.nonConverging.outcome,
        maliciousCandidate: result.negative.maliciousCandidate.effect,
        poisonedTraining: result.negative.poisonedTraining.outcome,
      },
    },
    null,
    2,
  ),
);
