/**
 * Config/secret resolution audit events (ADR-0027).
 * Values are always redacted — only refs, sources, and version-ids.
 */

import { CREDENTIAL_AUDIT_RETENTION } from "./events.js";
import type { JsonObject } from "./json.js";

// public-contract: config/secret audit event schema id (ADR-0027).
export const CONFIG_SECRET_EVENT_SCHEMA = "hobo.config-secret-events/v1";

export type SecretSourceRank =
	| "bound-resource"
	| "provider-federation"
	| "camp-value"
	| "static-escape";

export type ConfigSecretEvent = Readonly<{
	id: string;
	type: "config.Resolved" | "secret.Accessed";
	schemaVersion: typeof CONFIG_SECRET_EVENT_SCHEMA;
	tenant: string;
	seq: number;
	time: string;
	actor: Readonly<{ kind: string; id: string }>;
	correlationId: string;
	causationId: string;
	retention: typeof CREDENTIAL_AUDIT_RETENTION;
	data: JsonObject;
}>;

export function createConfigResolvedEvent(input: {
	name: string;
	source: SecretSourceRank;
	valueRef?: string;
	/** ADR-0142 classification — never a plaintext value. */
	sensitivity?: "public" | "internal" | "sensitive";
	tenant: string;
	subject?: string;
	seq?: number;
	time?: string;
}): ConfigSecretEvent {
	return Object.freeze({
		id: `evt-config-resolved-${input.name}-${input.seq ?? 0}`,
		type: "config.Resolved",
		schemaVersion: CONFIG_SECRET_EVENT_SCHEMA,
		tenant: input.tenant,
		seq: input.seq ?? 0,
		time: input.time ?? new Date().toISOString(),
		actor: { kind: "service", id: "yard/config-resolver" },
		correlationId: `corr-config-${input.name}`,
		causationId: `cmd-resolve-${input.name}`,
		retention: CREDENTIAL_AUDIT_RETENTION,
		data: Object.freeze({
			name: input.name,
			source: input.source,
			// Never a value — ref + classification only.
			...(input.valueRef !== undefined
				? { valueRef: input.valueRef }
				: undefined),
			...(input.sensitivity !== undefined
				? { sensitivity: input.sensitivity }
				: undefined),
			...(input.subject !== undefined ? { subject: input.subject } : undefined),
			redacted: true,
		}),
	});
}

export function createSecretAccessedEvent(input: {
	name: string;
	source: SecretSourceRank;
	valueRef: string;
	versionId?: string;
	tenant: string;
	subject?: string;
	/** Linked token.Used / grant id when joined. */
	grantId?: string;
	seq?: number;
	time?: string;
}): ConfigSecretEvent {
	return Object.freeze({
		id: `evt-secret-accessed-${input.name}-${input.seq ?? 0}`,
		type: "secret.Accessed",
		schemaVersion: CONFIG_SECRET_EVENT_SCHEMA,
		tenant: input.tenant,
		seq: input.seq ?? 0,
		time: input.time ?? new Date().toISOString(),
		actor: { kind: "service", id: "yard/secrets" },
		correlationId: `corr-secret-${input.name}`,
		causationId: `cmd-access-${input.name}`,
		retention: CREDENTIAL_AUDIT_RETENTION,
		data: Object.freeze({
			name: input.name,
			source: input.source,
			valueRef: input.valueRef,
			...(input.versionId !== undefined
				? { versionId: input.versionId }
				: undefined),
			...(input.subject !== undefined ? { subject: input.subject } : undefined),
			...(input.grantId !== undefined ? { grantId: input.grantId } : undefined),
			// Explicit invariant for conformance oracles.
			redacted: true,
			plaintextPresent: false,
		}),
	});
}

export function assertNoPlaintextInEvent(event: ConfigSecretEvent): void {
	const json = JSON.stringify(event);
	if (event.data.plaintextPresent === true) {
		throw new Error("secret event claims plaintextPresent");
	}
	// Heuristic: block common secret patterns in event payloads.
	if (
		/"password"\s*:\s*"[^"]+"/i.test(json) ||
		/"secret"\s*:\s*"[^"]{8,}"/i.test(json) ||
		/"apiKey"\s*:\s*"[^"]+"/i.test(json)
	) {
		throw new Error("plaintext secret pattern detected in event");
	}
}
