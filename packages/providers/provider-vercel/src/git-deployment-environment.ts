/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: this module parses untrusted public deployment environment and signed context JSON before recording it. */
/** Approved public deployment configuration. Credential values never enter this path. */
import { createPublicKey } from "node:crypto";
import { parseSecretRef } from "@hobo/bindings";
import { canonicalJson, ResolverError } from "@hobo/core";
import {
	isJsonArray,
	isJsonObject,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "./json.js";

export type VercelGitEnvironmentVariable = Readonly<{
	name: string;
	value: string;
}>;
export type VercelGitEnvironmentScope = Readonly<{
	teamId: string;
	projectId: string;
	revision: string;
}>;

const CD_NAMES = [
	"BLOB_STORE_ID",
	"HOBO_CD_CONFIG_PROJECTION",
	"HOBO_CD_HOST_CONTEXT",
	"INFISICAL_ENVIRONMENT",
	"INFISICAL_IDENTITY_ID",
	"INFISICAL_PROJECT_ID",
	"INFISICAL_SECRET_PATH",
	"INFISICAL_SITE_URL",
] as const;
const CI_NAMES = ["HOBO_CI_CACHE_MEMBERS", "HOBO_CI_CACHE_QUORUM"] as const;
const ALLOWED_NAMES: ReadonlySet<string> = new Set([...CD_NAMES, ...CI_NAMES]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

function fail(): never {
	throw new ResolverError(
		"RESOLVER_PRODUCT_UNSUPPORTED",
		"Vercel deployment environment contains unapproved or invalid public configuration",
	);
}
function record(
	value: JsonValue | undefined,
	required: readonly string[],
	optional: readonly string[] = [],
): JsonObject {
	if (
		!isJsonObject(value) ||
		required.some((key) => !Object.hasOwn(value, key)) ||
		Object.keys(value).some(
			(key) => !required.includes(key) && !optional.includes(key),
		)
	)
		return fail();
	return value;
}
function id(value: JsonValue | undefined): string {
	if (
		typeof value !== "string" ||
		!IDENTIFIER.test(value) ||
		/^(?:ghp_|gho_|sk[-_]|xox[abpsr]-|eyJ)/u.test(value)
	)
		return fail();
	return value;
}
function url(value: JsonValue | undefined, originOnly = true): string {
	if (typeof value !== "string" || value.length > 512) return fail();
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return fail();
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash ||
		(originOnly && parsed.pathname !== "/") ||
		parsed.hostname === "localhost"
	)
		return fail();
	return value;
}
function json(value: string): JsonValue {
	if (Buffer.byteLength(value, "utf8") > 65536) return fail();
	const parsed = parseJsonValue(value);
	if (parsed === null) return fail();
	return parsed;
}
function peer(input: JsonValue | undefined): JsonObject {
	const p = record(input, ["yard", "camp", "provider", "accountId"]);
	for (const field of ["yard", "camp", "provider", "accountId"]) id(p[field]);
	return p;
}
function junctionScope(
	input: JsonValue | undefined,
	expected: VercelGitEnvironmentScope,
): JsonObject {
	const s = record(input, [
		"deploymentId",
		"revision",
		"junction",
		"edge",
		"tier",
		"consumer",
		"producer",
		"capability",
		"resourceId",
	]);
	for (const field of ["deploymentId", "junction", "capability", "resourceId"])
		id(s[field]);
	const consumer = peer(s.consumer),
		producer = peer(s.producer);
	if (
		s.revision !== expected.revision ||
		s.tier !== "public-authenticated-tls" ||
		consumer.provider !== "vercel" ||
		consumer.accountId !== expected.teamId ||
		consumer.yard === producer.yard ||
		(s.edge !== `${consumer.yard}->${producer.yard}` &&
			s.edge !== `${producer.yard}->${consumer.yard}`)
	)
		return fail();
	return s;
}
function evidence(input: JsonValue | undefined) {
	const e = record(input, ["digest", "observedAtMs", "expiresAtMs"]);
	if (
		typeof e.digest !== "string" ||
		!/^sha256:[a-f0-9]{64}$/u.test(e.digest) ||
		typeof e.observedAtMs !== "number" ||
		!Number.isSafeInteger(e.observedAtMs) ||
		typeof e.expiresAtMs !== "number" ||
		!Number.isSafeInteger(e.expiresAtMs) ||
		e.observedAtMs < 0 ||
		e.expiresAtMs <= e.observedAtMs
	)
		return fail();
}
function cd(
	values: ReadonlyMap<string, string>,
	expected: VercelGitEnvironmentScope,
) {
	if (CD_NAMES.some((name) => !values.has(name))) return fail();
	const context = record(json(values.get("HOBO_CD_HOST_CONTEXT") ?? ""), [
		"contract",
		"deploymentId",
		"revision",
		"tenant",
		"station",
		"controlSecretRef",
		"vercelProjectId",
		"projectionPointers",
		"journal",
		"artifacts",
		"config",
		"trustedKeys",
		"hostingHealth",
	]);
	if (
		context.contract !== "hobo.cd-host-context/v1" ||
		context.revision !== expected.revision ||
		context.vercelProjectId !== expected.projectId
	)
		return fail();
	id(context.deploymentId);
	id(context.tenant);
	id(context.station);
	if (typeof context.controlSecretRef !== "string") return fail();
	try {
		if (parseSecretRef(context.controlSecretRef).scheme !== "infisical")
			return fail();
	} catch {
		return fail();
	}
	const pointer = record(context.projectionPointers, [
		"storeId",
		"journalScope",
		"artifactsScope",
		"configScope",
	]);
	if (
		typeof pointer.storeId !== "string" ||
		!/^store_[A-Za-z0-9_-]{1,128}$/u.test(pointer.storeId) ||
		pointer.storeId !== values.get("BLOB_STORE_ID") ||
		id(pointer.journalScope) === id(pointer.artifactsScope) ||
		[id(pointer.journalScope), id(pointer.artifactsScope)].includes(
			id(pointer.configScope),
		)
	)
		return fail();
	const scopes = [
		junctionScope(context.journal, expected),
		junctionScope(context.artifacts, expected),
		junctionScope(context.config, expected),
	];
	if (
		scopes.some((s) => s.deploymentId !== context.deploymentId) ||
		scopes[0]?.capability !== "data.postgres/v1" ||
		scopes[1]?.capability !== "bucket.s3-compatible/v1" ||
		scopes[2]?.capability !== "secret-ref.dynamic-resolution/v1" ||
		!isJsonObject(scopes[2]?.producer) ||
		scopes[2]?.producer.provider !== "infisical" ||
		new Set(scopes.map((s) => s.junction)).size !== 3 ||
		new Set(scopes.map((s) => canonicalJson(s.consumer))).size !== 1
	)
		return fail();
	const health = record(context.hostingHealth, [
		"planHash",
		"capabilityDigest",
		"jurisdiction",
	]);
	if (
		typeof health.planHash !== "string" ||
		!/^sha256:[a-f0-9]{64}$/u.test(health.planHash)
	)
		return fail();
	id(health.capabilityDigest);
	id(health.jurisdiction);
	if (
		!isJsonArray(context.trustedKeys) ||
		!context.trustedKeys.length ||
		context.trustedKeys.length > 16
	)
		return fail();
	const keys = new Set<string>();
	for (const item of context.trustedKeys) {
		const key = record(item, ["id", "publicKey"]);
		const keyId = id(key.id);
		if (
			keys.has(keyId) ||
			typeof key.publicKey !== "string" ||
			!/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n?$/u.test(
				key.publicKey,
			)
		)
			return fail();
		try {
			if (createPublicKey(key.publicKey).asymmetricKeyType !== "ed25519")
				return fail();
		} catch {
			return fail();
		}
		keys.add(keyId);
	}
	const envelope = record(json(values.get("HOBO_CD_CONFIG_PROJECTION") ?? ""), [
		"keyId",
		"payload",
		"signature",
	]);
	if (
		!keys.has(id(envelope.keyId)) ||
		typeof envelope.signature !== "string" ||
		!/^[A-Za-z0-9_-]{86}$/u.test(envelope.signature)
	)
		return fail();
	const payload = record(envelope.payload, [
		"contract",
		"deploymentId",
		"revision",
		"junction",
		"edge",
		"tier",
		"consumer",
		"producer",
		"capability",
		"resourceId",
		"binding",
		"producerEvidence",
		"consumerEvidence",
		"issuedAtMs",
		"expiresAtMs",
	]);
	const projectedScope: Record<string, JsonValue> = {};
	for (const key of [
		"deploymentId",
		"revision",
		"junction",
		"edge",
		"tier",
		"consumer",
		"producer",
		"capability",
		"resourceId",
	]) {
		const value = payload[key];
		if (value === undefined) return fail();
		projectedScope[key] = value;
	}
	if (
		payload.contract !== "hobo.junction-projection/v1" ||
		canonicalJson(projectedScope) !== canonicalJson(scopes[2]) ||
		typeof payload.issuedAtMs !== "number" ||
		!Number.isSafeInteger(payload.issuedAtMs) ||
		typeof payload.expiresAtMs !== "number" ||
		!Number.isSafeInteger(payload.expiresAtMs) ||
		payload.expiresAtMs <= payload.issuedAtMs
	)
		return fail();
	evidence(payload.producerEvidence);
	evidence(payload.consumerEvidence);
	const binding = record(payload.binding, [
		"kind",
		"endpoint",
		"projectId",
		"environment",
		"folder",
		"identityId",
		"issuer",
		"subject",
		"audience",
		"claims",
		"tls",
	]);
	if (
		binding.kind !== "infisical" ||
		binding.tls !== "verify-full" ||
		url(binding.endpoint) !== values.get("INFISICAL_SITE_URL") ||
		id(binding.projectId) !== values.get("INFISICAL_PROJECT_ID") ||
		id(binding.environment) !== values.get("INFISICAL_ENVIRONMENT") ||
		id(binding.identityId) !== values.get("INFISICAL_IDENTITY_ID") ||
		typeof binding.folder !== "string" ||
		!/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/u.test(binding.folder) ||
		binding.folder !== values.get("INFISICAL_SECRET_PATH")
	)
		return fail();
	url(binding.issuer, false);
	if (
		typeof binding.subject !== "string" ||
		!/^[A-Za-z0-9._:/*-]{1,1024}$/u.test(binding.subject)
	)
		return fail();
	if (
		typeof binding.audience !== "string" ||
		binding.audience.length > 1024 ||
		!/^[A-Za-z0-9._:/-]+$/u.test(binding.audience)
	)
		return fail();
	const claims = record(binding.claims, ["owner_id", "project_id"]);
	if (
		claims.owner_id !== expected.teamId ||
		claims.project_id !== expected.projectId
	)
		return fail();
}

/** Parse before persisting a plan and again before issuing provider requests.
 * Signature authority, freshness and the fleet's approved membership are
 * checked by the host using the existing Junction verification machinery. */
export function parseVercelGitEnvironment(
	raw: JsonValue | undefined,
	expected: VercelGitEnvironmentScope,
): readonly VercelGitEnvironmentVariable[] {
	if (
		!IDENTIFIER.test(expected.teamId) ||
		!/^prj_[A-Za-z0-9_-]{1,128}$/u.test(expected.projectId) ||
		!/^[a-f0-9]{40}$/u.test(expected.revision)
	)
		return fail();
	if (raw === undefined) return [];
	if (!isJsonArray(raw) || raw.length > CD_NAMES.length + CI_NAMES.length)
		return fail();
	const entries: VercelGitEnvironmentVariable[] = [],
		values = new Map<string, string>();
	let total = 0;
	for (const entry of raw) {
		const row = record(entry, ["name", "value"]);
		if (
			typeof row.name !== "string" ||
			!ALLOWED_NAMES.has(row.name) ||
			typeof row.value !== "string" ||
			values.has(row.name)
		)
			return fail();
		total +=
			Buffer.byteLength(row.name, "utf8") +
			Buffer.byteLength(row.value, "utf8");
		if (total > 65536) return fail();
		values.set(row.name, row.value);
		entries.push({ name: row.name, value: row.value });
	}
	if (CD_NAMES.some((name) => values.has(name))) cd(values, expected);
	const members = values.get("HOBO_CI_CACHE_MEMBERS"),
		quorum = values.get("HOBO_CI_CACHE_QUORUM");
	if (quorum && !members) return fail();
	if (members) {
		const parsed = json(members);
		if (
			!isJsonArray(parsed) ||
			parsed.length < 1 ||
			parsed.length > 8 ||
			parsed.some(
				(member) =>
					typeof member !== "string" ||
					![
						"upstash",
						"upstash-blob",
						"valkey",
						"redis",
						"turso",
						"blob",
						"cloudflare-d1",
						"supabase-postgres",
					].includes(member),
			) ||
			new Set(parsed).size !== parsed.length
		)
			return fail();
		if (
			quorum &&
			(parsed.length < 3 ||
				parsed.length % 2 === 0 ||
				!/^[1-7]$/u.test(quorum) ||
				Number(quorum) !== Math.floor(parsed.length / 2) + 1)
		)
			return fail();
	}
	return entries.sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
	);
}
