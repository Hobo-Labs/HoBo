/**
 * can-deploy dimension for secretless-first config schemas (ADR-0027).
 * Fail-closed on over-privileged ranking, malformed static hatch, plaintext defaults.
 */
import {
	type ConfigSchema,
	SECRET_SOURCE_RANKS,
	type SecretSourceRank,
	sourceRankIndex,
} from "./config-schema.js";

function assertTtl(ttl: string): void {
	const match = /^(\d+)d$/.exec(ttl);
	if (!match) {
		throw new TypeError(`static-escape ttl must be Nd, got ${ttl}`);
	}
	if (Number(match[1]) > 7) {
		throw new Error(`static-escape ttl ${ttl} exceeds 7d ceiling`);
	}
}

export type ConfigGateReason = Readonly<{
	code:
		| "sensitive-default"
		| "static-escape-forbidden"
		| "static-escape-ttl"
		| "static-escape-rotation"
		| "unknown-source"
		| "schema-malformed"
		| "plaintext-in-schema";
	field?: string;
	message: string;
}>;

export type SecretlessConfigGateResult = Readonly<{
	ok: boolean;
	dimension: "secretless-config";
	reasons: readonly ConfigGateReason[];
	summary: string;
	/** Ranking ceiling applied. */
	allowedSources: readonly SecretSourceRank[];
}>;

export type SecretlessConfigGateInput = Readonly<{
	schema: ConfigSchema;
	/** Production-like environments forbid static-escape by default. */
	environment?: "production" | "staging" | "dev" | "test";
	/** Explicit policy deny-ceiling (overrides environment default). */
	allowedSources?: readonly SecretSourceRank[];
	forbidStaticEscape?: boolean;
}>;

const PROD_DEFAULT: readonly SecretSourceRank[] = Object.freeze([
	"bound-resource",
	"provider-federation",
	"camp-value",
]);

const DEV_DEFAULT: readonly SecretSourceRank[] = Object.freeze([
	"bound-resource",
	"provider-federation",
	"camp-value",
	"static-escape",
]);

/**
 * Validate a Bindle config schema for can-deploy / architecture gates.
 */
export function evaluateSecretlessConfigGate(
	input: SecretlessConfigGateInput,
): SecretlessConfigGateResult {
	const env = input.environment ?? "production";
	const forbidStatic =
		input.forbidStaticEscape ?? (env === "production" || env === "staging");
	const allowed =
		input.allowedSources ?? (forbidStatic ? PROD_DEFAULT : DEV_DEFAULT);

	const reasons: ConfigGateReason[] = [];

	if (input.schema?.kind !== "config-schema") {
		return {
			ok: false,
			dimension: "secretless-config",
			reasons: [
				{
					code: "schema-malformed",
					message: "config schema missing or wrong kind",
				},
			],
			summary: "blocked: malformed config schema",
			allowedSources: allowed,
		};
	}

	const json = JSON.stringify(input.schema);
	if (
		/"password"\s*:\s*"[^"]+"/i.test(json) ||
		/"apiKey"\s*:\s*"[^"]+"/i.test(json) ||
		/"secret"\s*:\s*"[^"]{8,}"/i.test(json)
	) {
		reasons.push({
			code: "plaintext-in-schema",
			message: "schema artifact appears to embed plaintext secret material",
		});
	}

	for (const [name, field] of Object.entries(input.schema.fields)) {
		if (field.sensitive && field.defaultValue !== undefined) {
			reasons.push({
				code: "sensitive-default",
				field: name,
				message: `sensitive field ${name} has a default value (forbidden)`,
			});
		}
		// SAFETY: assertion required at this I/O or test boundary.
		if (!(SECRET_SOURCE_RANKS as readonly string[]).includes(field.source)) {
			reasons.push({
				code: "unknown-source",
				field: name,
				message: `field ${name} has unknown source ${field.source}`,
			});
			continue;
		}
		if (!allowed.includes(field.source)) {
			reasons.push({
				code: "static-escape-forbidden",
				field: name,
				message: `field ${name} source ${field.source} exceeds policy ceiling (allowed: ${allowed.join(",")})`,
			});
		}
		if (field.source === "static-escape") {
			try {
				assertTtl(field.ttl ?? "7d");
			} catch (err) {
				reasons.push({
					code: "static-escape-ttl",
					field: name,
					message: err instanceof Error ? err.message : String(err),
				});
			}
			if (field.rotation !== "required" && field.rotation !== "optional") {
				reasons.push({
					code: "static-escape-rotation",
					field: name,
					message: `field ${name} static-escape requires rotation policy`,
				});
			}
		}
		// Ranking hygiene: sensitive should not prefer camp-value.
		if (field.sensitive && field.source === "camp-value") {
			reasons.push({
				code: "unknown-source",
				field: name,
				message: `sensitive field ${name} must not use camp-value (rank ${sourceRankIndex(field.source)})`,
			});
		}
	}

	const ok = reasons.length === 0;
	return Object.freeze({
		ok,
		dimension: "secretless-config",
		reasons: Object.freeze(reasons),
		summary: ok
			? "secretless-config:ok"
			: `blocked: secretless-config (${reasons[0]?.code})`,
		allowedSources: Object.freeze([...allowed]),
	});
}
