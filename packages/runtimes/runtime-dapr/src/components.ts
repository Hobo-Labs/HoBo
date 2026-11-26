/**
 * Generate Dapr component YAML from HoBo Resource Definitions + .allow() scopes.
 * Metadata values are binding refs only — secretless-first.
 */

import { MessagingParseError } from "@hobo/core";
import { cloneAsJson, isJsonObject } from "./json.js";

import type { DaprComponentSpec, DaprComponentYaml } from "./types.js";

const FORBIDDEN_META = [
	"password",
	"saslPassword",
	"clientSecret",
	"accessKey",
	"secretKey",
	"apiKey",
];

export function parseDaprComponentSpec<T>(input: T): DaprComponentSpec {
	const json = cloneAsJson(input);
	if (!isJsonObject(json)) {
		throw new MessagingParseError("DaprComponentSpec", "object", json);
	}
	const src = json;
	const metadata: Record<string, string> = {};
	const rawMeta = isJsonObject(src.metadata) ? src.metadata : {};
	for (const [k, v] of Object.entries(rawMeta)) {
		if (FORBIDDEN_META.includes(k)) {
			throw new MessagingParseError(
				`metadata.${k}`,
				"binding ref (secretless)",
				v,
			);
		}
		metadata[k] = String(v);
	}
	const scopes = Array.isArray(src.scopes)
		? src.scopes.map((s) => String(s))
		: [];
	return Object.freeze({
		name: String(src.name ?? ""),
		type: String(src.type ?? ""),
		version: String(src.version ?? "v1"),
		metadata,
		scopes,
	});
}

/**
 * Build Dapr Component CR YAML. Happy path: no hand-written parallel config.
 */
export function generateDaprComponentYaml(
	spec: DaprComponentSpec,
): DaprComponentYaml {
	if (!spec.name || !spec.type) {
		throw new MessagingParseError("component", "name+type", cloneAsJson(spec));
	}
	const metaLines = Object.entries(spec.metadata)
		.map(([k, v]) => `    - name: ${k}\n      value: "${v}"`)
		.join("\n");
	const scopes =
		spec.scopes.length > 0
			? `scopes:\n${spec.scopes.map((s) => `  - ${s}`).join("\n")}\n`
			: "";
	const body = `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: ${spec.name}
spec:
  type: ${spec.type}
  version: ${spec.version}
  metadata:
${metaLines || "    []"}
${scopes}`.trimEnd();

	return Object.freeze({
		apiVersion: "dapr.io/v1alpha1",
		kind: "Component",
		name: spec.name,
		body: `${body}\n`,
		secretless: true as const,
	});
}

/** Kafka pubsub component from HoBo Kafka cluster binding (no secrets inline). */
export function kafkaPubsubComponent(input: {
	readonly name?: string;
	readonly bootstrapServersBinding: string;
	readonly consumerGroup?: string;
	readonly scopes?: readonly string[];
}): DaprComponentSpec {
	return parseDaprComponentSpec({
		name: input.name ?? "pubsub",
		type: "pubsub.kafka",
		version: "v1",
		metadata: {
			brokers: input.bootstrapServersBinding,
			authType: "oidc",
			consumerGroup: input.consumerGroup ?? "hobo",
			// Secretless: binding ref for any SASL/OIDC material
			clientAuthBinding: "fromBinding:kafka-client",
		},
		scopes: input.scopes ?? [],
	});
}

/** Map HoBo .allow() verbs to Dapr component scopes (app-ids). */
export function scopesFromAllow(
	appId: string,
	allows: readonly string[],
): string[] {
	// Dapr scopes are app-ids; .allow() verbs constrain link grants in HoBo.
	// Component is scoped to the tenant app-id; verbs stay in HoBo policy.
	void allows;
	return [appId];
}
