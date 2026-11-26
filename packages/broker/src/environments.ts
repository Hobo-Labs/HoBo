import { BROKER_EVENTS, type BrokerEvent, brokerEvent } from "./events.js";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import { BrokerParseError } from "./policies.js";

// Broker Environments (the HOBO-526/HOBO-527 admin-controls requirements, now
// runtime): the approved input state a resolution must validate against —
// which providers may be used, and which catalog snapshot the decision must
// be made over. Publication PROPOSES an environment; approval is a separate
// admin fact; the broker only ever resolves against APPROVED state. This is
// the backend the Admin Console's broker-environment UX drives.

// domain-view: approved broker input state; wire form is BrokerEnvironment in data-models/broker.proto.
export interface BrokerEnvironment {
	environmentId: string;
	approvedProviders: readonly string[];
	catalogHash?: string;
	approved: boolean;
	approvedBy?: string;
}

export function parseBrokerEnvironment(
	input: JsonValue | undefined,
): BrokerEnvironment {
	if (input === null || !isJsonObject(input) || Array.isArray(input)) {
		throw new BrokerParseError(
			"invalid-environment",
			"invalid-environment: expected an object",
		);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const raw = input as JsonObject;
	const environmentId = raw.environmentId ?? raw.environment_id;
	if (!isJsonString(environmentId) || environmentId.length === 0) {
		throw new BrokerParseError(
			"invalid-environment",
			"invalid-environment: environmentId must be a non-empty string",
		);
	}
	const providersRaw = raw.approvedProviders ?? raw.approved_providers;
	const approvedProviders = Array.isArray(providersRaw)
		? providersRaw.filter(
				(entry): entry is string => isJsonString(entry) && entry.length > 0,
			)
		: [];
	const catalogHash = raw.catalogHash ?? raw.catalog_hash;
	const approvedBy = raw.approvedBy ?? raw.approved_by;
	return {
		environmentId,
		approvedProviders,
		...(isJsonString(catalogHash) && catalogHash.length > 0
			? { catalogHash }
			: undefined),
		approved: raw.approved === true,
		...(isJsonString(approvedBy) && approvedBy.length > 0
			? { approvedBy }
			: undefined),
	};
}

export function publishEnvironmentFact(input: JsonValue | undefined) {
	const environment = { ...parseBrokerEnvironment(input), approved: false };
	return {
		environment,
		event: brokerEvent(BROKER_EVENTS.EnvironmentPublished, {
			environmentId: environment.environmentId,
			approvedProviders: [...environment.approvedProviders],
			...(environment.catalogHash !== undefined
				? { catalogHash: environment.catalogHash }
				: undefined),
		}),
	};
}

export function approveEnvironmentFact(
	environmentId: string,
	approvedBy: string,
): BrokerEvent {
	if (environmentId.length === 0 || approvedBy.length === 0) {
		throw new BrokerParseError(
			"invalid-environment",
			"invalid-environment: approval needs environmentId and approvedBy",
		);
	}
	return brokerEvent(BROKER_EVENTS.EnvironmentApproved, {
		environmentId,
		approvedBy,
	});
}

// Fold publication/approval facts into the environment read model —
// rebuildable from zero; only the fold decides what counts as approved.
export function foldBrokerEnvironments(
	events: Iterable<{ type: string; data?: unknown }>,
): BrokerEnvironment[] {
	const rows = new Map<string, BrokerEnvironment>();
	for (const event of events) {
		// SAFETY: assertion required at this I/O or test boundary.
		const data = (event.data ?? {}) as JsonObject;
		const environmentId = data.environmentId;
		if (!isJsonString(environmentId) || environmentId.length === 0) continue;
		if (event.type === BROKER_EVENTS.EnvironmentPublished) {
			rows.set(environmentId, {
				...parseBrokerEnvironment(data),
				approved: false,
			});
		} else if (event.type === BROKER_EVENTS.EnvironmentApproved) {
			const existing = rows.get(environmentId);
			if (existing !== undefined) {
				rows.set(environmentId, {
					...existing,
					approved: true,
					...(isJsonString(data.approvedBy)
						? { approvedBy: data.approvedBy }
						: undefined),
				});
			}
		}
	}
	return [...rows.values()];
}
