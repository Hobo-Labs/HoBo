import {
	type AgentConfigSchemaView,
	createAgentConfigSchemaView,
} from "@hobo/core";
import {
	type ConfigSchema,
	configSensitivity,
	type SecretSourceRank,
} from "./config-types.js";
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
	agentView: AgentConfigSchemaView;
	events: readonly ConfigSecretEvent[];
}>;

export type ConfigResolverOptions = Readonly<{
	tenant: string;
	schema: ConfigSchema;
	allowedSources?: readonly SecretSourceRank[];
	campValues?: JsonObject;
	secretsPort?: SecretsPort;
	boundTokens?: Readonly<Record<string, () => Promise<string | undefined>>>;
	staticMaterials?: Readonly<Record<string, string>>;
	forbidStaticEscape?: boolean;
	subject?: string;
}>;

const DEFAULT_ALLOWED: readonly SecretSourceRank[] = Object.freeze([
	"bound-resource",
	"provider-federation",
	"camp-value",
	"static-escape",
]);

export async function resolveConfigSchema(
	options: ConfigResolverOptions,
): Promise<ConfigResolutionResult> {
	let allowed = options.allowedSources ?? DEFAULT_ALLOWED;
	if (options.forbidStaticEscape) {
		allowed = allowed.filter((s) => s !== "static-escape");
	}

	const entries: Record<string, ResolvedConfigEntry> = {};
	const events: ConfigSecretEvent[] = [];
	let seq = 0;

	for (const [name, field] of Object.entries(options.schema.fields)) {
		const sensitivity = configSensitivity(field);
		const result = await resolveConfigEntry({
			name,
			sensitive: sensitivity === "sensitive",
			sensitivity,
			preferredSource: field.source,
			allowedSources: allowed,
			campValue: ownValue(options.campValues, name) ?? field.defaultValue,
			secretsPort: options.secretsPort,
			staticMaterial: ownValue(options.staticMaterials, name),
			boundToken: ownValue(options.boundTokens, name),
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

		Object.defineProperty(entries, name, {
			value: result.entry,
			enumerable: true,
		});
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

		if (result.entry.sensitive && result.entry.valueRef) {
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
		agentView: createAgentConfigSchemaView(options.schema),
		events: Object.freeze(events),
	});
}

function ownValue<T>(
	record: Readonly<Record<string, T>> | undefined,
	name: string,
): T | undefined {
	return record && Object.hasOwn(record, name) ? record[name] : undefined;
}
