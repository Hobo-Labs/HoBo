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
	DEPLOYMENT_PLAN_SCHEMA,
	type DeploymentPlan,
	type GatekeeperApproval,
	type MatchSelection,
	RESOLVED_SET_SCHEMA,
	type ResolvedDeploymentSet,
	type ResourcePlan,
} from "@hobo/cloud";
import type { JsonValue } from "@hobo/core";
import {
	ChangeKind,
	type ResourceChange,
	ResourceChangeSchema,
} from "../_generated/cd_pb.js";
import type { Digest } from "../ports.js";
import { DesiredStateError } from "./errors.js";
import {
	canonicalJson,
	isFlag,
	isJsonObject,
	isNumber,
	isText,
	isTextList,
	member,
	sortDeep,
	toJsonValue,
} from "./json.js";

export { canonicalJson } from "./json.js";

declare const canonicalBrand: unique symbol;

/** A verified ResolvedDeploymentSet in canonical key order. */
export type CanonicalResolvedSet = ResolvedDeploymentSet & {
	readonly [canonicalBrand]: "cd.CanonicalResolvedSet";
};

export type ResolvedSetBlob = Readonly<{
	bytes: Uint8Array;
	digest: Digest;
	size: number;
}>;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const GATE_DECISIONS: ReadonlySet<string> = new Set([
	"allow",
	"allow-degraded",
]);

export function sha256Digest(bytes: Uint8Array | string): Digest {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function invalid(message: string, subject = ""): DesiredStateError {
	return new DesiredStateError("resolved-set-invalid", message, subject);
}

function requireText(document: JsonValue, field: string): string {
	const value = member(document, field);
	if (!isText(value) || value === "") {
		throw invalid(`${field} must be a non-empty string`);
	}
	return value;
}

function requireDigest(document: JsonValue, field: string): `sha256:${string}` {
	const value = member(document, field);
	if (!isText(value) || !DIGEST.test(value)) {
		throw invalid(`${field} must be sha256:<64 hex>`);
	}
	return `sha256:${value.slice("sha256:".length)}`;
}

function isResourcePlan<T>(value: T): value is T & ResourcePlan {
	const name = member(value, "name");
	return (
		isJsonObject(value) &&
		isText(name) &&
		name !== "" &&
		isText(member(value, "port")) &&
		isText(member(value, "provider")) &&
		isTextList(member(value, "deps"))
	);
}

function isDeploymentPlan<T>(value: T): value is T & DeploymentPlan {
	const resources = member(value, "resources");
	return (
		isJsonObject(value) &&
		member(value, "schema") === DEPLOYMENT_PLAN_SCHEMA &&
		isText(member(value, "objective")) &&
		isTextList(member(value, "dependencyOrder")) &&
		Array.isArray(resources) &&
		resources.every((resource) => isResourcePlan(resource))
	);
}

function isMatchSelection<T>(value: T): value is T & MatchSelection {
	return (
		isText(member(value, "resource")) &&
		isText(member(value, "providerId")) &&
		isText(member(value, "port")) &&
		isText(member(value, "rationale"))
	);
}

function isGatekeeperApproval<T>(value: T): value is T & GatekeeperApproval {
	const decision = member(value, "decision");
	return (
		isText(decision) &&
		GATE_DECISIONS.has(decision) &&
		isText(member(value, "gatekeeperDecisionId")) &&
		isTextList(member(value, "obligations")) &&
		isText(member(value, "decidedAt"))
	);
}

type ProgressiveHints = NonNullable<ResolvedDeploymentSet["progressive"]>;

function isProgressiveHints<T>(value: T): value is T & ProgressiveHints {
	const flag = member(value, "flag");
	const stages = member(value, "stages");
	const traffic = member(value, "traffic");
	const autoRollback = member(value, "autoRollback");
	return (
		isJsonObject(value) &&
		(flag === undefined || isText(flag)) &&
		(stages === undefined ||
			(Array.isArray(stages) && stages.every((stage) => isNumber(stage)))) &&
		(traffic === undefined ||
			traffic === "flag-only" ||
			traffic === "gateway-weighted") &&
		(autoRollback === undefined || isFlag(autoRollback))
	);
}

/** Parse an untrusted resolved-set document into the @hobo/cloud domain type. */
function parseResolvedDocument(document: JsonValue): ResolvedDeploymentSet {
	if (!isJsonObject(document))
		throw invalid("resolved set must be a JSON object");
	if (member(document, "schemaVersion") !== RESOLVED_SET_SCHEMA) {
		throw invalid(`schemaVersion must be ${RESOLVED_SET_SCHEMA}`);
	}
	const plan = member(document, "plan");
	if (!isDeploymentPlan(plan)) {
		throw invalid(
			"plan must be a DeploymentPlan (schema, objective, dependencyOrder, resources with name/port/provider/deps)",
		);
	}
	const matches = member(document, "matches");
	if (
		!Array.isArray(matches) ||
		!matches.every((match) => isMatchSelection(match))
	) {
		throw invalid("matches must be a list of Matching selections");
	}
	const gatekeeper = member(document, "gatekeeper");
	if (!isGatekeeperApproval(gatekeeper))
		throw invalid("gatekeeper approval is required");
	const secretRefs = member(document, "secretRefs");
	if (!isTextList(secretRefs))
		throw invalid("secretRefs must be a list of references");
	const parsed: ResolvedDeploymentSet = {
		schemaVersion: RESOLVED_SET_SCHEMA,
		setId: requireText(document, "setId"),
		tenant: requireText(document, "tenant"),
		environment: requireText(document, "environment"),
		campId: requireText(document, "campId"),
		plan,
		planHash: requireDigest(document, "planHash"),
		matches: matches.filter((match) => isMatchSelection(match)),
		gatekeeper,
		secretRefs,
		contentHash: requireDigest(document, "contentHash"),
	};
	const progressive = member(document, "progressive");
	if (progressive === undefined) return parsed;
	if (!isProgressiveHints(progressive))
		throw invalid("progressive hints are malformed");
	return { ...parsed, progressive };
}

function rebuild(resolved: ResolvedDeploymentSet): ResolvedDeploymentSet {
	const input: Parameters<typeof createResolvedDeploymentSet>[0] = {
		tenant: resolved.tenant,
		environment: resolved.environment,
		campId: resolved.campId,
		plan: resolved.plan,
		matches: resolved.matches,
		gatekeeper: resolved.gatekeeper,
		secretRefs: resolved.secretRefs,
		setId: resolved.setId,
	};
	try {
		return createResolvedDeploymentSet(
			resolved.progressive === undefined
				? input
				: { ...input, progressive: resolved.progressive },
		);
	} catch (error) {
		throw invalid(
			error instanceof Error
				? error.message
				: "resolved set rejected by its constructor",
			resolved.campId,
		);
	}
}

function checkSecretFree(resolved: ResolvedDeploymentSet): void {
	try {
		assertSecretFree(resolved);
	} catch (error) {
		const path =
			error instanceof Error && "path" in error && isText(error.path)
				? error.path
				: "$";
		throw new DesiredStateError(
			"secret-material",
			`plaintext secret material at ${path}`,
			resolved.campId,
		);
	}
}

function checkDependencies(plan: DeploymentPlan, subject: string): void {
	const names = new Set<string>();
	for (const resource of plan.resources) {
		if (names.has(resource.name)) {
			throw invalid(`duplicate resource ${resource.name}`, subject);
		}
		names.add(resource.name);
	}
	for (const resource of plan.resources) {
		for (const dep of resource.deps) {
			if (!names.has(dep)) {
				throw new DesiredStateError(
					"missing-dependency",
					`${resource.name} has missing dependency ${dep}`,
					subject,
				);
			}
		}
	}
}

/** Rebuild in sorted key order so content identity is independent of key order (HOBO-50). */
function canonicalize(document: ResolvedDeploymentSet): CanonicalResolvedSet {
	const sorted = parseResolvedDocument(sortDeep(toJsonValue(document)));
	// SAFETY: brand applied after verification; rebuild recomputes both hashes.
	return Object.freeze(rebuild(sorted)) as CanonicalResolvedSet;
}

/**
 * Verify an in-memory resolved set and return it in canonical key order.
 * Order: structure → secret-free → closed dependencies → the producer's own hashes.
 */
export function verifyResolvedSet(
	input: ResolvedDeploymentSet,
): CanonicalResolvedSet {
	const document = parseResolvedDocument(toJsonValue(input));
	checkSecretFree(document);
	checkDependencies(document.plan, document.campId);
	const recomputed = rebuild(input);
	if (
		recomputed.planHash !== input.planHash ||
		recomputed.contentHash !== input.contentHash
	) {
		throw invalid(
			"plan or content hash does not match the resolved set",
			input.campId,
		);
	}
	return canonicalize(document);
}

export function encodeResolvedSetBlob(
	input: ResolvedDeploymentSet,
): ResolvedSetBlob & { resolved: CanonicalResolvedSet } {
	const resolved = verifyResolvedSet(input);
	const bytes = new TextEncoder().encode(canonicalJson(resolved));
	return Object.freeze({
		bytes,
		digest: sha256Digest(bytes),
		size: bytes.byteLength,
		resolved,
	});
}

function parseBlobJson(bytes: Uint8Array, subject: string): JsonValue {
	try {
		// SAFETY: JSON.parse yields a JSON value at this document boundary.
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		) as JsonValue;
	} catch {
		throw invalid("blob is not UTF-8 JSON", subject);
	}
}

/** Decode a stored blob, refusing any digest/size mismatch before parsing. */
export function decodeResolvedSetBlob(
	bytes: Uint8Array,
	expected: Readonly<{ digest: string; size?: number }>,
): CanonicalResolvedSet {
	const digest = sha256Digest(bytes);
	if (
		digest !== expected.digest ||
		(expected.size !== undefined && expected.size !== bytes.byteLength)
	) {
		throw new DesiredStateError(
			"resolved-set-digest-mismatch",
			`blob ${expected.digest} hashes to ${digest} (${bytes.byteLength} bytes)`,
			expected.digest,
		);
	}
	const document = parseResolvedDocument(parseBlobJson(bytes, expected.digest));
	checkSecretFree(document);
	checkDependencies(document.plan, document.campId);
	const canonical = canonicalize(document);
	if (
		canonical.contentHash !== document.contentHash ||
		canonical.planHash !== document.planHash
	) {
		throw invalid("blob content hash does not verify", expected.digest);
	}
	return canonical;
}

function resourceHash(resolved: ResolvedDeploymentSet, name: string): string {
	const resource = resolved.plan.resources.find((r) => r.name === name);
	const matches = resolved.matches.filter((m) => m.resource === name);
	return sha256Digest(canonicalJson({ resource, matches }));
}

function changeKind(present: { was: boolean; now: boolean }): ChangeKind {
	if (!present.was) return ChangeKind.ADD;
	if (!present.now) return ChangeKind.REMOVE;
	return ChangeKind.UPDATE;
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
		const source = now ? after : before;
		const provider =
			source?.matches.find((m) => m.resource === name)?.providerId ??
			node?.provider ??
			"";
		changes.push(
			create(ResourceChangeSchema, {
				resource: name,
				kind: changeKind({ was: was !== undefined, now: now !== undefined }),
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
export function resourceNames(
	resolved: ResolvedDeploymentSet | undefined,
): ReadonlySet<string> {
	return new Set(resolved?.plan.resources.map((r) => r.name) ?? []);
}
