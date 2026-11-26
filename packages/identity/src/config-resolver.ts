/**
 * Schema-driven config resolution orchestration (ADR-0027).
 * Agents receive schemaOnlyView placeholders only.
 */

import type { ConfigSchema, SecretSourceRank } from "./config-types.js";
import type { JsonObject } from "./json.js";
import {
	assertNoPlaintextInEvent,
	type ConfigSecretEvent,
	createConfigResolvedEvent,
	createSecretAccessedEvent,
} from "./secrets-events.js";
import {
	type ResolvedConfigEntry,
	resolveConfigEntry,
	type SecretsPort,
} from "./secrets-port.js";

export type ConfigResolutionResult = Readonly<{
	entries: Readonly<Record<string, ResolvedConfigEntry>>;
	/** Agent-safe: placeholders only. */
	agentView: Readonly<Record<string, string>>;
	events: readonly ConfigSecretEvent[];
}>;

export type ConfigResolverOptions = Readonly<{
	tenant: string;
	schema: ConfigSchema;
	/** Policy deny-ceiling: which ranks may be used. */
	allowedSources?: readonly SecretSourceRank[];
	campValues?: JsonObject;
	secretsPort?: SecretsPort;
	/** Bound-resource token mint (SVID brokered). */
	boundTokens?: Readonly<Record<string, () => Promise<string | undefined>>>;
	/** Static hatch material keyed by field name (broker-only). */
	staticMaterials?: Readonly<Record<string, string>>;
	/** Forbid static-escape even if schema asks (production default often true). */
	forbidStaticEscape?: boolean;
	subject?: string;
}>;

const DEFAULT_ALLOWED: readonly SecretSourceRank[] = Object.freeze([
	"bound-resource",
	"provider-federation",
	"camp-value",
	"static-escape",
]);

/**
 * Resolve all schema fields via the ranked ladder. Sensitive material never
 * appears in agentView or events.
 */
export async function resolveConfigSchema(
	options: ConfigResolverOptions,
): Promise<ConfigResolutionResult> {
	let allowed = options.allowedSources ?? DEFAULT_ALLOWED;
	if (options.forbidStaticEscape) {
		allowed = allowed.filter((s) => s !== "static-escape");
	}

	const entries: Record<string, ResolvedConfigEntry> = {};
	const agentView: Record<string, string> = {};
	const events: ConfigSecretEvent[] = [];
	let seq = 0;

	for (const [name, field] of Object.entries(options.schema.fields)) {
		if (!allowed.includes(field.source) && field.required) {
			// Still try lower ranks if preferred is forbidden.
		}
		const result = await resolveConfigEntry({
			name,
			sensitive: field.sensitive,
			preferredSource: field.source,
			allowedSources: allowed,
			campValue: options.campValues?.[name] ?? field.defaultValue,
			secretsPort: options.secretsPort,
			staticMaterial: options.staticMaterials?.[name],
			boundToken: options.boundTokens?.[name],
		});

		if (result.status === "denied") {
			if (field.required) {
				throw Object.assign(
					new Error(`required config ${name}: ${result.reason}`),
					{ code: result.code },
				);
			}
			continue;
		}

		entries[name] = result.entry;
		agentView[name] = result.entry.placeholder;

		seq += 1;
		const resolvedEvt = createConfigResolvedEvent({
			name,
			source: result.entry.source,
			valueRef: result.entry.valueRef,
			sensitivity: result.entry.sensitivity,
			tenant: options.tenant,
			subject: options.subject,
			seq,
		});
		assertNoPlaintextInEvent(resolvedEvt);
		events.push(resolvedEvt);

		if (field.sensitive && result.entry.valueRef) {
			seq += 1;
			const accessEvt = createSecretAccessedEvent({
				name,
				source: result.entry.source,
				valueRef: result.entry.valueRef,
				versionId: result.entry.versionId,
				tenant: options.tenant,
				subject: options.subject,
				seq,
			});
			assertNoPlaintextInEvent(accessEvt);
			events.push(accessEvt);
		}
	}

	return Object.freeze({
		entries: Object.freeze(entries),
		agentView: Object.freeze(agentView),
		events: Object.freeze(events),
	});
}
