import { isJsonString, isJsonObject } from "./json.js";
export const CONTRACT_ENGINE_PORT = "hobo:contract-engine/contract-engine@0.1.0";
export const BUILT_IN_ENGINE_ID = "hobo.contract-engine.builtin-pact-style/v1";

const CONTRACT_MODES = new Set(["declared", "inferred", "observed", "promoted"]);

export function createContractEngine(options = {}) {
  rejectBehaviorToggle(options);
  if ("provider" in options || "engineProvider" in options) {
    throw new Error("contract-engine is built-in-only; providers are import/export adapters only");
  }

  return Object.freeze({
    id: BUILT_IN_ENGINE_ID,
    port: CONTRACT_ENGINE_PORT,
    behavior: "built-in-pact-style-consumer-driven",
    verify(request) {
      return verifyContractPair(request);
    },
  });
}

export function verifyContractPair({ graph, eventLog = [], producer, consumer, providedContract }) {
  const expectations = deriveConsumerExpectations({ graph, eventLog, producer, consumer });
  const failures = [];

  if (!providedContract || !isJsonObject(providedContract)) {
    failures.push("providedContract must be an object");
  }

  for (const expectation of expectations) {
    if (providedContract?.channel !== expectation.channel) {
      failures.push(`${expectation.id}: channel ${expectation.channel} was not provided`);
      continue;
    }

    const providedFields = new Set(providedContract.fields ?? []);
    for (const field of expectation.requiredFields) {
      if (!providedFields.has(field)) {
        failures.push(`${expectation.id}: missing required field ${field}`);
      }
    }
  }

  return {
    ok: expectations.length > 0 && failures.length === 0,
    engineId: BUILT_IN_ENGINE_ID,
    port: CONTRACT_ENGINE_PORT,
    behavior: "built-in-pact-style-consumer-driven",
    expectations,
    failures,
  };
}

export function deriveConsumerExpectations({ graph, eventLog = [], producer, consumer }) {
  const contracts = Array.isArray(graph?.contracts) ? graph.contracts : [];
  const observationsByContractId = observedSampleCounts(eventLog);

  return contracts
    .filter((contract) => contract.producer === producer && contract.consumer === consumer)
    .map((contract) => {
      validateContractIr(contract);

      return {
        id: contract.id,
        source: "graph+event-log",
        kind: contract.kind,
        mode: contract.mode,
        producer: contract.producer,
        consumer: contract.consumer,
        channel: contract.channel,
        requiredFields: [...contract.requiredFields],
        optionalFields: [...(contract.optionalFields ?? [])],
        observedSamples: observationsByContractId.get(contract.id) ?? 0,
      };
    });
}

export function exportPactBrokerContract({ contractIr, producer, consumer }) {
  const contracts = contractIr.filter(
    (contract) => contract.producer === producer && contract.consumer === consumer,
  );

  return {
    metadata: {
      source: "hobo-contract-ir",
      sourceOfTruth: false,
      adapter: "provider-pact",
    },
    consumer: { name: consumer },
    provider: { name: producer },
    interactions: contracts.map((contract) => {
      validateContractIr(contract);

      return {
        description: `${contract.consumer} consumes ${contract.channel}`,
        providerState: `${contract.producer} publishes ${contract.channel}`,
        hoboContractId: contract.id,
        request: {
          method: "EVENT",
          path: contract.channel,
        },
        response: {
          matchingRules: {
            body: Object.fromEntries(
              contract.requiredFields.map((field) => [
                `$.${field}`,
                { required: true, source: "hobo-contract-ir" },
              ]),
            ),
          },
        },
      };
    }),
  };
}

export function importPactBrokerContract(pact) {
  if (pact?.metadata?.sourceOfTruth === true) {
    throw new Error("Pact imports cannot become the Contract IR source of truth");
  }

  const contracts = (pact?.interactions ?? []).map((interaction) => {
    const requiredFields = Object.keys(interaction.response?.matchingRules?.body ?? {})
      .map((selector) => selector.replace(/^\$\./, ""))
      .sort();

    return {
      id: interaction.hoboContractId,
      kind: "event",
      producer: pact.provider?.name,
      consumer: pact.consumer?.name,
      channel: interaction.request?.path,
      mode: "observed",
      requiredFields,
      sourceOfTruth: false,
    };
  });

  return {
    authority: "interop-import",
    contracts,
  };
}

export function registerContractEngineProvider(name) {
  throw new Error(`contract-engine is built-in-only; ${name} can only be an interop adapter`);
}

function rejectBehaviorToggle(options) {
  const forbiddenToggles = [
    "consumerDrivenTesting",
    "pactStyleTesting",
    "disablePactStyleTesting",
    "setContractBehavior",
  ];

  for (const key of forbiddenToggles) {
    if (key in options) {
      throw new Error("consumer-driven testing is mandatory and has no behavior toggle");
    }
  }
}

function validateContractIr(contract) {
  if (!contract || !isJsonObject(contract)) {
    throw new Error("contract must be an object");
  }
  for (const field of ["id", "kind", "producer", "consumer", "channel", "mode"]) {
    if (!isJsonString(contract[field]) || contract[field].length === 0) {
      throw new Error(`contract.${field} must be a non-empty string`);
    }
  }
  if (!CONTRACT_MODES.has(contract.mode)) {
    throw new Error(`contract.mode must be one of ${[...CONTRACT_MODES].join(", ")}`);
  }
  if (!Array.isArray(contract.requiredFields)) {
    throw new Error("contract.requiredFields must be an array");
  }
}

function observedSampleCounts(eventLog) {
  const observed = new Map();
  for (const event of eventLog) {
    if (event?.type !== "contract.Observed" || !isJsonString(event.contractId)) {
      continue;
    }
    observed.set(event.contractId, (observed.get(event.contractId) ?? 0) + (event.sampleCount ?? 0));
  }
  return observed;
}
