// Resolved-set blobs (B3, B4): a Set never inlines its plan in an event. The
// canonical, secret-free ResolvedDeploymentSet is stored content-addressed in
// the ArtifactStore and verified on every read.
//
// Parse, don't validate: `verifyResolvedSet` and `decodeResolvedSetBlob` are the
// only constructors of `CanonicalResolvedSet`, the derived type every other
// function in this module accepts. A value of that type has verified hashes,
// closed dependencies, no plaintext secrets, and key-order-independent content
// identity.
import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	assertSecretFree,
	createResolvedDeploymentSet,
	type DeploymentPlan,
	RESOLVED_SET_SCHEMA,
	type ResolvedDeploymentSet,
} from "@hobo/cloud";
import { ChangeKind, type ResourceChange, ResourceChangeSchema } from "../_generated/cd_pb.js";
import type { Digest } from "../ports.js";
import { DesiredStateError } from "./errors.js";

declare const canonicalBrand: unique symbol;

/** A verified ResolvedDeploymentSet in canonical key order. */
export type CanonicalResolvedSet = ResolvedDeploymentSet & { readonly [canonicalBrand]: "cd.CanonicalResolvedSet" };

export type ResolvedSetBlob = Readonly<{ bytes: Uint8Array; digest: Digest; size: number }>;

const tagOf = Object.prototype.toString;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && value !== undefined && !Array.isArray(value) && tagOf.call(value) === "[object Object]";
}

function isString(value: unknown): value is string {
	return tagOf.call(value) === "[object String]";
}

function isStringList(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every(isString);
}

/** Key-sorted at every depth (arrays keep their order); code-unit order, locale-free. */
export function sortDeep(value: unknown): Json {
	if (Array.isArray(value)) return value.map(sortDeep);
	if (isObject(value)) {
		const out: Record<string, Json> = {};
		for (const key of Object.keys(value).sort()) {
			const child = value[key];
			if (child !== undefined) out[key] = sortDeep(child);
		}
		return out;
	}
	if (value === undefined) return null;
	// SAFETY: every remaining JSON-document value is a scalar.
	return value as Json;
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortDeep(value));
}

export function sha256Digest(bytes: Uint8Array | string): Digest {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function invalid(message: string, subject = ""): DesiredStateError {
	return new DesiredStateError("resolved-set-invalid", message, subject);
}

/** Structural parse of an untrusted resolved-set document. */
function parseShape(value: unknown): ResolvedDeploymentSet {
	if (!isObject(value)) throw invalid("resolved set must be a JSON object");
	if (value.schemaVersion !== RESOLVED_SET_SCHEMA) throw invalid(`schemaVersion must be ${RESOLVED_SET_SCHEMA}`);
	for (const field of ["setId", "tenant", "environment", "campId"] as const) {
		if (!isString(value[field]) || value[field] === "") throw invalid(`${field} must be a non-empty string`);
	}
	for (const field of ["planHash", "contentHash"] as const) {
		const hash = value[field];
		if (!isString(hash) || !DIGEST.test(hash)) throw invalid(`${field} must be sha256:<64 hex>`);
	}
	const plan = value.plan;
	if (!isObject(plan) || !isString(plan.schema) || !isString(plan.objective)) throw invalid("plan must be a DeploymentPlan");
	if (!Array.isArray(plan.resources) || !isStringList(plan.dependencyOrder)) throw invalid("plan.resources and plan.dependencyOrder are required");
	for (const [index, resource] of plan.resources.entries()) {
		if (!isObject(resource) || !isString(resource.name) || resource.name === "") throw invalid(`plan.resources[${index}].name is required`);
		if (!isString(resource.port) || !isString(resource.provider) || !isStringList(resource.deps)) {
			throw invalid(`plan.resources[${index}] needs port, provider and deps`, resource.name);
		}
	}
	if (!Array.isArray(value.matches) || !value.matches.every((m) => isObject(m) && isString(m.resource) && isString(m.providerId))) {
		throw invalid("matches must be a list of Matching selections");
	}
	const gatekeeper = value.gatekeeper;
	if (!isObject(gatekeeper) || !isString(gatekeeper.decision) || !isString(gatekeeper.gatekeeperDecisionId)) {
		throw invalid("gatekeeper approval is required");
	}
	if (!isStringList(value.secretRefs)) throw invalid("secretRefs must be a list of references");
	// SAFETY: every field read above was checked against the ResolvedDeploymentSet shape.
	return value as ResolvedDeploymentSet;
}

function rebuild(resolved: ResolvedDeploymentSet): ResolvedDeploymentSet {
	try {
		return createResolvedDeploymentSet({
			tenant: resolved.tenant,
			environment: resolved.environment,
			campId: resolved.campId,
			plan: resolved.plan,
			matches: resolved.matches,
			gatekeeper: resolved.gatekeeper,
			secretRefs: resolved.secretRefs,
			setId: resolved.setId,
			...(resolved.progressive !== undefined ? { progressive: resolved.progressive } : {}),
		});
	} catch (error) {
		throw invalid(error instanceof Error ? error.message : "resolved set rejected by its constructor", resolved.campId);
	}
}

function checkSecretFree(resolved: ResolvedDeploymentSet): void {
	try {
		assertSecretFree(resolved);
	} catch (error) {
		const path = isObject(error) && isString(error.path) ? error.path : "$";
		throw new DesiredStateError("secret-material", `plaintext secret material at ${path}`, resolved.campId);
	}
}

function checkDependencies(plan: DeploymentPlan, subject: string): void {
	const names = new Set<string>();
	for (const resource of plan.resources) {
		if (names.has(resource.name)) throw invalid(`duplicate resource ${resource.name}`, subject);
		names.add(resource.name);
	}
	for (const resource of plan.resources) {
		for (const dep of resource.deps) {
			if (!names.has(dep)) {
				throw new DesiredStateError("missing-dependency", `${resource.name} has missing dependency ${dep}`, subject);
			}
		}
	}
}

/**
 * Verify an in-memory resolved set and return it in canonical key order.
 * Order: shape → secret-free → closed dependencies → the producer's own hashes.
 */
export function verifyResolvedSet(input: ResolvedDeploymentSet): CanonicalResolvedSet {
	const shaped = parseShape(JSON.parse(JSON.stringify(input)));
	checkSecretFree(shaped);
	checkDependencies(shaped.plan, shaped.campId);
	const recomputed = rebuild(input);
	if (recomputed.planHash !== input.planHash || recomputed.contentHash !== input.contentHash) {
		throw invalid("plan or content hash does not match the resolved set", input.campId);
	}
	return canonicalize(shaped);
}

/** Rebuild in sorted key order so content identity is independent of key order (HOBO-50). */
function canonicalize(shaped: ResolvedDeploymentSet): CanonicalResolvedSet {
	const sorted = parseShape(sortDeep(shaped));
	// SAFETY: brand applied after verification; rebuild recomputes both hashes.
	return Object.freeze(rebuild(sorted)) as CanonicalResolvedSet;
}

export function encodeResolvedSetBlob(input: ResolvedDeploymentSet): ResolvedSetBlob & { resolved: CanonicalResolvedSet } {
	const resolved = verifyResolvedSet(input);
	const bytes = new TextEncoder().encode(canonicalJson(resolved));
	return Object.freeze({ bytes, digest: sha256Digest(bytes), size: bytes.byteLength, resolved });
}

/** Decode a stored blob, refusing any digest/size mismatch before parsing. */
export function decodeResolvedSetBlob(
	bytes: Uint8Array,
	expected: Readonly<{ digest: string; size?: number }>,
): CanonicalResolvedSet {
	const digest = sha256Digest(bytes);
	if (digest !== expected.digest || (expected.size !== undefined && expected.size !== bytes.byteLength)) {
		throw new DesiredStateError(
			"resolved-set-digest-mismatch",
			`blob ${expected.digest} hashes to ${digest} (${bytes.byteLength} bytes)`,
			expected.digest,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw invalid("blob is not UTF-8 JSON", expected.digest);
	}
	const shaped = parseShape(parsed);
	checkSecretFree(shaped);
	checkDependencies(shaped.plan, shaped.campId);
	const canonical = canonicalize(shaped);
	if (canonical.contentHash !== shaped.contentHash || canonical.planHash !== shaped.planHash) {
		throw invalid("blob content hash does not verify", expected.digest);
	}
	return canonical;
}

function resourceHash(resolved: ResolvedDeploymentSet, name: string): string {
	const resource = resolved.plan.resources.find((r) => r.name === name);
	const matches = resolved.matches.filter((m) => m.resource === name);
	return sha256Digest(canonicalJson({ resource, matches }));
}

/**
 * Resource-level diff between two resolved sets (HOBO-50 add/update/remove),
 * sorted by resource name. A resource is updated when its plan node or its
 * Matching selection changed.
 */
export function diffResolvedSets(
	before: ResolvedDeploymentSet | undefined,
	after: ResolvedDeploymentSet,
): ResourceChange[] {
	const names = new Set<string>([
		...(before?.plan.resources.map((r) => r.name) ?? []),
		...after.plan.resources.map((r) => r.name),
	]);
	const changes: ResourceChange[] = [];
	for (const name of [...names].sort()) {
		const was = before?.plan.resources.find((r) => r.name === name);
		const now = after.plan.resources.find((r) => r.name === name);
		const beforeHash = was && before ? resourceHash(before, name) : "";
		const afterHash = now ? resourceHash(after, name) : "";
		if (beforeHash === afterHash) continue;
		const node = now ?? was;
		const kind = !was ? ChangeKind.ADD : !now ? ChangeKind.REMOVE : ChangeKind.UPDATE;
		const source = now ? after : before;
		const provider = source?.matches.find((m) => m.resource === name)?.providerId ?? node?.provider ?? "";
		changes.push(
			create(ResourceChangeSchema, {
				resource: name,
				kind,
				provider,
				productId: node?.productId ?? "",
				beforeHash,
				afterHash,
			}),
		);
	}
	return changes;
}

/** Names present in a resolved set (used to check Delta changes against a base). */
export function resourceNames(resolved: ResolvedDeploymentSet | undefined): ReadonlySet<string> {
	return new Set(resolved?.plan.resources.map((r) => r.name) ?? []);
}
