import { BROKER_EVENTS, type BrokerEvent, brokerEvent } from "./events.js";
import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import { BrokerParseError } from "./policies.js";
import {
	CONNECTOR_KINDS,
	type ConnectorConfig,
	type ConnectorKind,
} from "./types.js";

const REQUIRED_SETTINGS = {
	"github-app": ["appId", "installationId"],
	pulumi: ["organization"],
	azure: ["subscriptionId", "tenantId"],
	vercel: ["teamId"],
	cloudflare: ["accountId"],
	agent37: ["workspaceId"],
	custom: [],
};

const AGENT37_ORIGINS = {
	apiOrigin: "api.agent37.com",
	execOrigin: "sandbox.agent37.app",
} as const;

function parseAgent37Origins(settings: JsonObject): void {
	for (const [setting, host] of Object.entries(AGENT37_ORIGINS)) {
		const value = settings[setting];
		if (value === undefined) continue;
		try {
			const origin = isJsonString(value) ? new URL(value) : undefined;
			if (
				origin?.protocol === "https:" &&
				origin.username === "" &&
				origin.password === "" &&
				origin.host === host &&
				origin.href === `https://${host}/`
			)
				continue;
		} catch {}
		throw new BrokerParseError(
			"invalid-connector-origin",
			`invalid-connector-origin: agent37 ${setting} must be the HTTPS origin for ${host} without credentials, a path, query, or fragment`,
		);
	}
}

export function parseConnectorConfig(
	input: JsonValue | undefined,
): ConnectorConfig {
	if (input === null || !isJsonObject(input) || Array.isArray(input)) {
		throw new BrokerParseError(
			"invalid-connector",
			"invalid-connector: expected an object",
		);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const raw = input as JsonObject;
	const id = raw.id;
	if (!isJsonString(id) || id.length === 0) {
		throw new BrokerParseError(
			"invalid-connector",
			"invalid-connector: id must be a non-empty string",
		);
	}
	const kind = raw.kind;
	if (
		!isJsonString(kind) ||
		// SAFETY: assertion required at this I/O or test boundary.
		!CONNECTOR_KINDS.includes(kind as ConnectorKind)
	) {
		throw new BrokerParseError(
			"invalid-connector-kind",
			`invalid-connector-kind: ${String(kind)} is not one of ${CONNECTOR_KINDS.join("|")}`,
		);
	}
	const displayName = raw.displayName ?? raw.display_name;
	if (!isJsonString(displayName) || displayName.length === 0) {
		throw new BrokerParseError(
			"invalid-connector",
			"invalid-connector: displayName must be a non-empty string",
		);
	}
	const settingsRaw = raw.settings ?? {};
	if (
		settingsRaw === null ||
		!isJsonObject(settingsRaw) ||
		Array.isArray(settingsRaw)
	) {
		throw new BrokerParseError(
			"invalid-connector",
			"invalid-connector: settings must be a string map",
		);
	}
	const settings: Record<string, string> = {};
	for (const [key, value] of Object.entries(settingsRaw)) {
		if (isJsonString(value)) settings[key] = value;
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const missing = REQUIRED_SETTINGS[kind as ConnectorKind].filter(
		(required) => settings[required] === undefined || settings[required] === "",
	);
	if (missing.length > 0) {
		throw new BrokerParseError(
			"connector-settings-missing",
			`connector-settings-missing: ${kind} requires settings ${missing.join(", ")}`,
		);
	}
	if (kind === "agent37") parseAgent37Origins(settingsRaw);
	const credentialRef = raw.credentialRef ?? raw.credential_ref;
	return {
		id,
		// SAFETY: assertion required at this I/O or test boundary.
		kind: kind as ConnectorKind,
		displayName,
		settings,
		...(isJsonString(credentialRef) && credentialRef.length > 0
			? { credentialRef }
			: undefined),
		enabled: raw.enabled !== false,
	};
}

export interface ConnectorRegistry {
	register(input: JsonValue | undefined): {
		connector: ConnectorConfig;
		event: BrokerEvent;
	};
	disable(id: string): BrokerEvent;
	list(): ConnectorConfig[];
	byKind(kind: ConnectorKind): ConnectorConfig[];
	missingKinds(required: readonly ConnectorKind[]): ConnectorKind[];
}

export function createConnectorRegistry(
	initial: readonly unknown[] = [],
): ConnectorRegistry {
	const connectors = new Map<string, ConnectorConfig>();
	for (const entry of initial) {
		const parsed = parseConnectorConfig(cloneAsJson(entry));
		connectors.set(parsed.id, parsed);
	}
	return {
		register(input) {
			const connector = parseConnectorConfig(input);
			connectors.set(connector.id, connector);
			return {
				connector,
				event: brokerEvent(BROKER_EVENTS.ConnectorRegistered, {
					connectorId: connector.id,
					kind: connector.kind,
					displayName: connector.displayName,
					enabled: connector.enabled,
				}),
			};
		},
		disable(id) {
			const existing = connectors.get(id);
			if (existing === undefined) {
				throw new BrokerParseError(
					"connector-unknown",
					`connector-unknown: ${id} is not registered`,
				);
			}
			connectors.set(id, { ...existing, enabled: false });
			return brokerEvent(BROKER_EVENTS.ConnectorDisabled, {
				connectorId: id,
				kind: existing.kind,
			});
		},
		list: () => [...connectors.values()],
		byKind: (kind) =>
			[...connectors.values()].filter(
				(connector) => connector.kind === kind && connector.enabled,
			),
		missingKinds(required) {
			const enabledKinds = new Set(
				[...connectors.values()]
					.filter((connector) => connector.enabled)
					.map((connector) => connector.kind),
			);
			return required.filter((kind) => !enabledKinds.has(kind));
		},
	};
}

// Fold `connector.Registered`/`connector.Disabled` facts back into the
// registry read model — rebuildable from zero, the event stream is truth.
export function foldConnectorRegistry(
	events: Iterable<{ type: string; data?: unknown }>,
): Array<{ connectorId: string; kind: string; enabled: boolean }> {
	const rows = new Map<
		string,
		{ connectorId: string; kind: string; enabled: boolean }
	>();
	for (const event of events) {
		// SAFETY: assertion required at this I/O or test boundary.
		const data = (event.data ?? {}) as JsonObject;
		const connectorId = data.connectorId;
		if (!isJsonString(connectorId) || connectorId.length === 0) continue;
		if (event.type === BROKER_EVENTS.ConnectorRegistered) {
			rows.set(connectorId, {
				connectorId,
				kind: isJsonString(data.kind) ? data.kind : "custom",
				enabled: data.enabled !== false,
			});
		} else if (event.type === BROKER_EVENTS.ConnectorDisabled) {
			const existing = rows.get(connectorId);
			if (existing !== undefined)
				rows.set(connectorId, { ...existing, enabled: false });
		}
	}
	return [...rows.values()];
}
