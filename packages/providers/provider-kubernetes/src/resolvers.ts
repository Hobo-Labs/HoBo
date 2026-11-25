/**
 * Direct apiserver resource resolvers for built-in Kubernetes objects.
 *
 * Why this module exists: this package shipped a *placement driver* — one
 * opinionated sequence that creates a Namespace, a Deployment and a Service for
 * a web workload — and no `ResourceResolver`, so a deploy routed through a Yard
 * failed closed for want of one. These resolvers close that gap: one convergent
 * `reconcile` per built-in object, talking to the apiserver over an injected,
 * guarded `HttpTransport`, with no IaC engine and no state file in the middle.
 * The driver in `./driver.ts` stays exactly as it was; it is the opinionated
 * path, this is the general one.
 *
 * The property that makes that safe is **convergence**, and Kubernetes makes it
 * unusually easy: every object here has a deterministic name inside a
 * namespace, so "does it already exist" is a single GET rather than a listing.
 * `reconcile()` reads first, creates only when the read says absent, and then
 * applies the mutable delta as a merge patch. Running it twice yields the same
 * `physicalId`, exactly one object, and exactly one create call. `delete()`
 * treats "already gone" as success for the same reason.
 *
 * Three deliberate refusals, each of which would otherwise be a plausible
 * convenience:
 *
 * 1. **The namespace is never defaulted.** A resolver that quietly fell back to
 *    `default` would put a workload in the busiest namespace in the cluster,
 *    where an RBAC mistake reaches everything. `desired.namespace` is required
 *    and its absence is a typed refusal naming the fix.
 * 2. **`"replace"` is never emitted.** A Job's pod template and a PVC's storage
 *    class are immutable, and "converging" them means deleting the object —
 *    which for a PVC deletes data and for a Job discards a completed run. Drift
 *    on an immutable field is reported as a diagnostic for a human.
 * 3. **Secrets ship no resolver at all.** Creating one means putting its
 *    contents in `desired`, and `desired` is recorded in the event log. The
 *    catalog still declares `kubernetes.secret/v1` as a *locator* row, which is
 *    the whole point of that profile — see
 *    {@link KUBERNETES_UNRESOLVED_PRODUCT_IDS}.
 *
 * Credentials are locators, never material. A resolver is constructed with an
 * injected `resolveCredential(ref)`; `ResolveRequest.credentialRef` must be a
 * `scheme://…` locator — the grammar core's `parseResolveRequest` enforces —
 * and a value that looks like a bearer token is refused, because a raw token in
 * a request record is a token in the event log. The token reaches exactly one
 * place: the `authorization` header. Apiserver `Status` text is passed through
 * `redactClusterText` before it reaches a message, because a Status routinely
 * quotes the object that caused it and those objects carry tokens.
 *
 * Determinism: no clock, no randomness, no environment reads.
 *
 * HONEST SCOPE (also in the README):
 *   - These resolvers are exercised against an *injected fake* transport
 *     modelling an apiserver. Nothing in this package proves a live deploy:
 *     that additionally needs a real cluster, real credentials and real network
 *     egress, none of which a unit test supplies.
 *   - They do **not** support `kubectl proxy`. The `ResourceResolver` contract
 *     runs over `@hobo/core`'s HTTPS-only transport guard; the cleartext
 *     loopback escape lives on the driver path and deliberately not here. See
 *     `./resolver-transport.ts`.
 *   - Coverage is the built-in objects named below and explicitly not the whole
 *     API. Anything an operator installs — a Postgres CRD, a queue CRD — is out
 *     of scope by construction, not by omission.
 *   - The `productId` strings are read off the `./slots.js` factories, so the
 *     registry and the Yard catalog cannot drift apart.
 */

import {
	createResolverRegistry,
	type HttpTransport,
	RESOLVER_CONTRACT,
	type ResolveOutcome,
	type ResolveRequest,
	type ResolverAction,
	ResolverError,
	type ResourceResolver,
	type SlotBinding,
	type TransportMethod,
	type TransportResponse,
} from "@hobo/core";
import { parseDeploymentRecord } from "./api.js";
import { redactClusterText } from "./errors.js";
import {
	isJsonObject,
	isJsonString,
	type JsonBag,
	type JsonObject,
	type JsonValue,
	type StringBag,
} from "./json.js";
import { PROVIDER_TARGET } from "./options.js";
import {
	guardedKubernetesTransport,
	kubernetesResolverUrl,
	parseApiServerEndpoint,
	RESOLVER_MAX_RESPONSE_BYTES,
	RESOLVER_MAX_TIMEOUT_MS,
} from "./resolver-transport.js";
import {
	cronJob,
	daemonSet,
	deployment,
	ingress,
	job,
	persistentVolumeClaim,
	secret,
	service,
	statefulSet,
} from "./slots.js";

// ---------------------------------------------------------------------------
// Product ids — read off the slot factories so the registry cannot drift from
// the catalog it is supposed to serve.
// ---------------------------------------------------------------------------

function productIdOf(binding: SlotBinding, factory: string): string {
	const { productId } = binding;
	if (productId === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`slot factory ${factory}() emitted a binding without a productId, so no resolver can be keyed to it`,
		);
	}
	return productId;
}

export const KUBERNETES_DEPLOYMENT_PRODUCT_ID = productIdOf(
	deployment(),
	"deployment",
);
export const KUBERNETES_SERVICE_PRODUCT_ID = productIdOf(service(), "service");
export const KUBERNETES_STATEFULSET_PRODUCT_ID = productIdOf(
	statefulSet(),
	"statefulSet",
);
export const KUBERNETES_DAEMONSET_PRODUCT_ID = productIdOf(
	daemonSet(),
	"daemonSet",
);
export const KUBERNETES_INGRESS_PRODUCT_ID = productIdOf(ingress(), "ingress");
export const KUBERNETES_JOB_PRODUCT_ID = productIdOf(job(), "job");
export const KUBERNETES_CRONJOB_PRODUCT_ID = productIdOf(cronJob(), "cronJob");
export const KUBERNETES_SECRET_PRODUCT_ID = productIdOf(secret(), "secret");
export const KUBERNETES_PVC_PRODUCT_ID = productIdOf(
	persistentVolumeClaim(),
	"persistentVolumeClaim",
);

/** Every product this module resolves, id-sorted for a deterministic registry. */
export const KUBERNETES_RESOLVED_PRODUCT_IDS: readonly string[] = Object.freeze(
	[
		KUBERNETES_CRONJOB_PRODUCT_ID,
		KUBERNETES_DAEMONSET_PRODUCT_ID,
		KUBERNETES_DEPLOYMENT_PRODUCT_ID,
		KUBERNETES_INGRESS_PRODUCT_ID,
		KUBERNETES_JOB_PRODUCT_ID,
		KUBERNETES_PVC_PRODUCT_ID,
		KUBERNETES_SECRET_PRODUCT_ID,
		KUBERNETES_SERVICE_PRODUCT_ID,
		KUBERNETES_STATEFULSET_PRODUCT_ID,
	].sort(compareStrings),
);

/**
 * Product ids this package catalogs but does not resolve.
 *
 * Empty. Every catalogued object has a convergent path against the apiserver,
 * the Secret included — its material arrives through an injected function
 * rather than through `desired`, so nothing about it reaches the event log.
 *
 * It is exported anyway, and the tests still assert that resolved + unresolved
 * accounts for the catalog exactly once. The list existing and being empty is a
 * different claim from the list not existing: an object added to `./slots.ts`
 * without a resolver has to be named here, and that is a decision a reviewer
 * sees rather than a gap nobody counted.
 */
export const KUBERNETES_UNRESOLVED_PRODUCT_IDS: readonly string[] =
	Object.freeze([]);

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** What a host must supply to build the resolvers. */
export interface KubernetesResolverOptions {
	/** The apiserver root, e.g. `https://cluster.example:6443`. HTTPS only. */
	readonly apiServerUrl: string;
	/**
	 * Resolves a credential *locator* to a bearer token (in practice a
	 * projected ServiceAccount token). Injected so the resolver never holds a
	 * secret and never decides where secrets live.
	 */
	readonly resolveCredential: (ref: string) => Promise<string>;
	/**
	 * Resolves the contents of one Secret, by logical id.
	 *
	 * Keyed by logical id rather than by anything in `desired`, because core
	 * refuses credential-shaped keys in a property bag: `desired` is recorded in
	 * the event log, the plan digest, and every diagnostic printed from them,
	 * and a Secret's whole content is material. The host maps the logical id to
	 * its own custody and hands back plain strings; this package base64-encodes
	 * them for the apiserver and holds them no longer than the call. Required
	 * only to build the Secret resolver.
	 */
	readonly resolveSecretData?: (
		logicalId: string,
	) => Promise<Readonly<Record<string, string>>>;
}

/**
 * A credential locator, using the same grammar core's `parseResolveRequest`
 * enforces (`scheme://path`, no userinfo). Restated here rather than imported
 * because a resolver must refuse a bad ref even when a caller skipped the parse
 * boundary — and a second grammar would be a second answer.
 */
const CREDENTIAL_REF_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^\s@]+$/u;

/**
 * A compact JWS, which is what a projected ServiceAccount token looks like when
 * someone pastes the value into `credentialRef` by mistake.
 */
const RAW_CREDENTIAL_PATTERN =
	/^(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{40,})$/u;

/** RFC 1123 subdomain: the name grammar every object here must satisfy. */
const OBJECT_NAME_PATTERN =
	/^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/u;

// ---------------------------------------------------------------------------
// Small shared parsers
// ---------------------------------------------------------------------------

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainObject<T>(value: T): value is T & JsonObject {
	if (value === null || !isJsonObject(value) || Array.isArray(value)) {
		return false;
	}
	const prototype: unknown = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function optionalString(record: JsonObject, key: string): string | undefined {
	const value = record[key];
	return isJsonString(value) && value.trim().length > 0 ? value : undefined;
}

function nestedRecord(record: JsonObject, key: string): JsonObject {
	const value = record[key];
	return isPlainObject(value) ? value : {};
}

/** Key-sorted JSON, so a spec compare does not depend on key order. */
function stableJson(value: JsonValue): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableJson(item)).join(",")}]`;
	}
	if (isPlainObject(value)) {
		return `{${Object.keys(value)
			.sort(compareStrings)
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key] ?? null)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

// ---------------------------------------------------------------------------
// Object kinds
// ---------------------------------------------------------------------------

/** Everything the generic reconcile needs to address one built-in kind. */
interface ObjectKind {
	/** `apps/v1`, `v1`, `batch/v1`, `networking.k8s.io/v1`. */
	readonly apiVersion: string;
	readonly kind: string;
	/** The allowlisted API root this kind lives under. */
	readonly apiRoot: string;
	/** The lower-case plural the apiserver uses in a path. */
	readonly plural: string;
	/**
	 * True when the whole spec is fixed at creation. A Job's pod template is;
	 * "converging" it would mean deleting a completed run.
	 */
	readonly specImmutable: boolean;
}

const OBJECT_KINDS: Readonly<Record<string, ObjectKind>> = Object.freeze({
	[KUBERNETES_DEPLOYMENT_PRODUCT_ID]: Object.freeze({
		apiVersion: "apps/v1",
		kind: "Deployment",
		apiRoot: "/apis/apps/v1",
		plural: "deployments",
		specImmutable: false,
	}),
	[KUBERNETES_SECRET_PRODUCT_ID]: Object.freeze({
		apiVersion: "v1",
		kind: "Secret",
		apiRoot: "/api/v1",
		plural: "secrets",
		// A Secret has no `spec`; it is resolved by SECRET_SPEC rather than by
		// the generic path, and this entry exists for the URL helpers only.
		specImmutable: false,
	}),
	[KUBERNETES_SERVICE_PRODUCT_ID]: Object.freeze({
		apiVersion: "v1",
		kind: "Service",
		apiRoot: "/api/v1",
		plural: "services",
		specImmutable: false,
	}),
	[KUBERNETES_INGRESS_PRODUCT_ID]: Object.freeze({
		apiVersion: "networking.k8s.io/v1",
		kind: "Ingress",
		apiRoot: "/apis/networking.k8s.io/v1",
		plural: "ingresses",
		specImmutable: false,
	}),
	[KUBERNETES_JOB_PRODUCT_ID]: Object.freeze({
		apiVersion: "batch/v1",
		kind: "Job",
		apiRoot: "/apis/batch/v1",
		plural: "jobs",
		// A Job's `spec.template` is immutable once created; the apiserver
		// rejects a patch that touches it, so drift is reported rather than
		// attempted.
		specImmutable: true,
	}),
	[KUBERNETES_STATEFULSET_PRODUCT_ID]: Object.freeze({
		apiVersion: "apps/v1",
		kind: "StatefulSet",
		apiRoot: "/apis/apps/v1",
		plural: "statefulsets",
		// `volumeClaimTemplates` and `serviceName` are immutable, and a patch
		// touching either is rejected by the apiserver. The whole spec is
		// treated as fixed rather than guessing which half of a drift is safe.
		specImmutable: true,
	}),
	[KUBERNETES_DAEMONSET_PRODUCT_ID]: Object.freeze({
		apiVersion: "apps/v1",
		kind: "DaemonSet",
		apiRoot: "/apis/apps/v1",
		plural: "daemonsets",
		specImmutable: false,
	}),
	[KUBERNETES_CRONJOB_PRODUCT_ID]: Object.freeze({
		apiVersion: "batch/v1",
		kind: "CronJob",
		apiRoot: "/apis/batch/v1",
		plural: "cronjobs",
		specImmutable: false,
	}),
	[KUBERNETES_PVC_PRODUCT_ID]: Object.freeze({
		apiVersion: "v1",
		kind: "PersistentVolumeClaim",
		apiRoot: "/api/v1",
		plural: "persistentvolumeclaims",
		// A PVC's storage class and access modes are fixed at creation and its
		// size only grows; a general patch would either be rejected or destroy
		// data, so drift is reported.
		specImmutable: true,
	}),
});

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

interface ApiCall {
	readonly method: TransportMethod;
	readonly path: string;
	readonly json?: unknown;
	/** Merge patches need their own content type; the apiserver is strict. */
	readonly contentType?: string;
}

async function send(
	context: KubernetesResolverContext,
	call: ApiCall,
): Promise<TransportResponse> {
	const body = call.json === undefined ? undefined : JSON.stringify(call.json);
	const guarded = guardedKubernetesTransport(
		context.transport,
		context.apiServerUrl,
	);
	return guarded({
		method: call.method,
		url: kubernetesResolverUrl(context.apiServerUrl, call.path),
		headers: {
			accept: "application/json",
			authorization: `Bearer ${context.token}`,
			...(body !== undefined
				? { "content-type": call.contentType ?? "application/json" }
				: undefined),
		},
		...(body !== undefined ? { body } : undefined),
		timeoutMs: RESOLVER_MAX_TIMEOUT_MS,
		maxResponseBytes: RESOLVER_MAX_RESPONSE_BYTES,
	});
}

function isNotFound(response: TransportResponse): boolean {
	return response.status === 404;
}

function parseJsonRecord(
	response: TransportResponse,
	label: string,
): JsonObject {
	if (response.body.trim().length === 0) return {};
	let parsed: JsonValue;
	try {
		// SAFETY: assertion to `) as unknown; } catch { throw new` is required at this boundary.
		parsed = JSON.parse(response.body) as JsonValue;
	} catch {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: the apiserver returned a status ${response.status} body that is not JSON, so the outcome of the call is unknown and it is refused rather than assumed`,
		);
	}
	if (!isPlainObject(parsed)) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: the apiserver returned JSON that is not an object (status ${response.status}), so the object it describes cannot be identified`,
		);
	}
	return parsed;
}

/**
 * The refusal path. A Kubernetes `Status` is
 * `{"kind":"Status","reason":"Forbidden","message":"…"}`, and the message
 * routinely quotes the object that caused it — objects that carry
 * ServiceAccount tokens and imagePullSecrets. `redactClusterText` is what makes
 * quoting it safe.
 */
function providerRejection(
	response: TransportResponse,
	label: string,
): ResolverError {
	let detail = "no error detail was returned";
	try {
		const status = parseJsonRecord(response, label);
		const reason = optionalString(status, "reason");
		const message = optionalString(status, "message");
		const parts = [reason, message].filter(
			(part): part is string => part !== undefined,
		);
		if (parts.length > 0) detail = redactClusterText(parts.join(": "));
	} catch {
		const snippet = response.body.trim();
		if (snippet.length > 0) detail = redactClusterText(snippet, 160);
	}
	return new ResolverError(
		"RESOLVER_PROVIDER_REJECTED",
		`${label}: the apiserver refused the call with status ${response.status}: ${detail}`,
	);
}

function expectOk(response: TransportResponse, label: string): JsonObject {
	if (response.status >= 400) throw providerRejection(response, label);
	return parseJsonRecord(response, label);
}

// ---------------------------------------------------------------------------
// Resolver plumbing
// ---------------------------------------------------------------------------

/** Everything a resolver body needs, with the credential already resolved. */
interface KubernetesResolverContext {
	readonly request: ResolveRequest;
	readonly transport: HttpTransport;
	readonly token: string;
	readonly apiServerUrl: string;
	/** The deterministic object name: `desired.name`, else the logical id. */
	readonly name: string;
	readonly namespace: string;
	readonly desired: JsonObject;
	readonly knownPhysicalId: string | undefined;
	/**
	 * The host's Secret custody, if it wired one. A function rather than a
	 * resolved map so nothing is fetched for a request that does not need it,
	 * and so material never sits on a context that gets passed around.
	 * Undefined on every path but the Secret.
	 */
	readonly resolveSecretData:
		| ((logicalId: string) => Promise<Readonly<Record<string, string>>>)
		| undefined;
}

function outcome(
	action: ResolverAction,
	physicalId: string,
	outputs: JsonObject,
	diagnostics: readonly string[],
): ResolveOutcome {
	return Object.freeze({
		contract: RESOLVER_CONTRACT,
		action,
		physicalId,
		outputs: Object.freeze({ ...outputs }),
		diagnostics: Object.freeze([...diagnostics]),
	});
}

/**
 * Existing object, no delta: `noop` when the caller already named it, `adopt`
 * when the resolver found something the request did not know about. The
 * distinction is the audit record — adopting an object somebody else created is
 * a fact an operator should see, not something folded into "nothing happened".
 */
function settledAction(context: KubernetesResolverContext): ResolverAction {
	return context.knownPhysicalId === undefined ? "adopt" : "noop";
}

async function resolveToken(
	request: ResolveRequest,
	resolve: (ref: string) => Promise<string>,
): Promise<string> {
	const ref = request.credentialRef;
	if (!isJsonString(ref) || ref.trim().length === 0) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			'kubernetes resolver: credentialRef is empty. Supply a locator such as "file:///var/run/secrets/kubernetes.io/serviceaccount/token" or "secret://camp/cluster-token" and register it with the host credential resolver; the resolver never accepts inline credential material',
		);
	}
	const trimmed = ref.trim();
	if (RAW_CREDENTIAL_PATTERN.test(trimmed)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			"kubernetes resolver: credentialRef looks like a bearer token rather than a locator. Store the ServiceAccount token with the host secret custody and pass its reference (scheme://path); a raw token in a ResolveRequest is a token in the event log",
		);
	}
	if (!CREDENTIAL_REF_PATTERN.test(trimmed)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			`kubernetes resolver: credentialRef ${JSON.stringify(redactClusterText(trimmed, 60))} is not a locator. Expected "<scheme>://<path>"`,
		);
	}
	let material: string;
	try {
		material = await resolve(trimmed);
	} catch (cause) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`kubernetes resolver: the host could not resolve credentialRef ${JSON.stringify(trimmed)}: ${redactClusterText(
				cause instanceof Error ? cause.message : String(cause),
				160,
			)}. Register the reference with the credential resolver before deploying`,
		);
	}
	if (!isJsonString(material) || material.trim().length === 0) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`kubernetes resolver: credentialRef ${JSON.stringify(trimmed)} resolved to nothing. A missing credential is refused rather than retried unauthenticated, which would surface at the apiserver as a confusing 401`,
		);
	}
	return material.trim();
}

function objectName(request: ResolveRequest, productId: string): string {
	const candidate =
		optionalString(request.desired, "name") ??
		(isJsonString(request.ref.logicalId) ? request.ref.logicalId : "");
	if (candidate.length === 0) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${productId}: the request names no object — set desired.name or ref.logicalId. The name is what makes reconcile convergent, so it is never generated here`,
		);
	}
	if (!OBJECT_NAME_PATTERN.test(candidate) || candidate.length > 253) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${productId}: ${JSON.stringify(candidate)} is not an RFC 1123 subdomain, so the apiserver would reject it. Kubernetes names are lower-case alphanumerics, '-' and '.', at most 253 characters; this is refused here rather than sent, because a name that fails validation server-side is indistinguishable from a permissions error in the reply`,
		);
	}
	return candidate;
}

/**
 * The namespace, never defaulted. Falling back to `default` would put a
 * workload in the busiest namespace in the cluster — the one where an RBAC
 * mistake reaches everything — because nobody said otherwise.
 */
function requiredNamespace(request: ResolveRequest, productId: string): string {
	const namespace = optionalString(request.desired, "namespace");
	if (namespace === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${productId}: the request names no namespace — set desired.namespace. This resolver never falls back to "default": that is the busiest namespace in most clusters and the one where an RBAC mistake reaches everything, so placing a workload there is a decision an operator makes, not a default`,
		);
	}
	if (!OBJECT_NAME_PATTERN.test(namespace) || namespace.length > 63) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${productId}: namespace ${JSON.stringify(namespace)} is not an RFC 1123 label, so the apiserver would reject it`,
		);
	}
	return namespace;
}

function knownPhysicalId(request: ResolveRequest): string | undefined {
	const value = request.ref.physicalId;
	return isJsonString(value) && value.trim().length > 0 ? value : undefined;
}

/**
 * The object spec the caller authored.
 *
 * Passed through rather than assembled field by field: a Deployment spec
 * carries replicas, a selector, a whole pod template with containers, probes,
 * volumes and affinity, and a resolver that rebuilt a subset of that would
 * silently drop everything it did not know about on the next reconcile.
 */
function desiredSpec(
	context: KubernetesResolverContext,
	productId: string,
): JsonObject {
	const spec = context.desired.spec;
	if (!isPlainObject(spec)) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${productId}: the request carries no desired.spec. A Kubernetes object is defined by its spec; this resolver forwards the spec you authored and owns only its name and namespace, because inventing a spec would run something nobody wrote`,
		);
	}
	return spec;
}

function desiredLabels(context: KubernetesResolverContext): JsonObject {
	const labels = context.desired.labels;
	return isPlainObject(labels) ? labels : {};
}

// ---------------------------------------------------------------------------
// Paths, bodies and outputs
// ---------------------------------------------------------------------------

function collectionPath(
	kind: ObjectKind,
	context: KubernetesResolverContext,
): string {
	return `${kind.apiRoot}/namespaces/${encodeURIComponent(context.namespace)}/${kind.plural}`;
}

function objectPath(
	kind: ObjectKind,
	context: KubernetesResolverContext,
): string {
	return `${collectionPath(kind, context)}/${encodeURIComponent(context.name)}`;
}

function objectBody(
	kind: ObjectKind,
	context: KubernetesResolverContext,
	spec: JsonObject,
): JsonObject {
	const labels = desiredLabels(context);
	return {
		apiVersion: kind.apiVersion,
		kind: kind.kind,
		metadata: {
			name: context.name,
			namespace: context.namespace,
			...(Object.keys(labels).length > 0 ? { labels } : undefined),
		},
		spec,
	};
}

/**
 * The in-cluster DNS name a Service publishes. It is deliberately not an
 * external URL: this resolver creates no LoadBalancer and installs no Ingress
 * controller, so advertising a public hostname would be claiming something it
 * never provisioned.
 */
function clusterDnsName(context: KubernetesResolverContext): string {
	return `${context.name}.${context.namespace}.svc.cluster.local`;
}

function objectOutputs(
	kind: ObjectKind,
	context: KubernetesResolverContext,
	record: JsonObject,
): JsonObject {
	const metadata = nestedRecord(record, "metadata");
	const uid = optionalString(metadata, "uid");
	const outputs: JsonBag = {
		name: context.name,
		namespace: context.namespace,
		kind: kind.kind,
		...(uid !== undefined ? { uid } : undefined),
		...(kind.kind === "Service"
			? { clusterDns: clusterDnsName(context) }
			: undefined),
	};
	if (kind.kind !== "Deployment") return outputs;
	try {
		const rollout = parseDeploymentRecord(JSON.stringify(record));
		outputs.ready = rollout.phase === "available";
		outputs.operationConfirmed = rollout.phase === "available";
		outputs.lifecycleStatus =
			rollout.phase === "available"
				? "ready"
				: rollout.phase === "failed"
					? "failed"
					: "pending";
		outputs.observedGeneration = rollout.observedGeneration;
		outputs.generation = rollout.generation;
		outputs.updatedReplicas = rollout.updatedReplicas;
		outputs.availableReplicas = rollout.availableReplicas;
		const containers = nestedRecord(
			nestedRecord(nestedRecord(record, "spec"), "template"),
			"spec",
		).containers;
		if (
			Array.isArray(containers) &&
			containers.length === 1 &&
			isJsonObject(containers[0])
		) {
			const image = optionalString(containers[0], "image");
			const digest = image?.match(/@(sha256:[a-f0-9]{64})$/u)?.[1];
			if (digest) outputs.artifactDigest = digest;
		}
	} catch {
		outputs.lifecycleStatus = "unknown";
		outputs.operationConfirmed = false;
	}
	return outputs;
}

function driftDiagnostics(
	kind: ObjectKind,
	observed: JsonObject,
	wanted: JsonObject,
): readonly string[] {
	if (stableJson(nestedRecord(observed, "spec")) === stableJson(wanted)) {
		return [];
	}
	return [
		`the live ${kind.kind}'s spec differs from the request, and this resolver will not converge it: a ${kind.kind}'s spec is fixed at creation, so changing it means deleting the object — which for a PersistentVolumeClaim destroys data and for a Job discards a completed run. Delete it deliberately and reconcile again, or leave it as it is`,
	];
}

// ---------------------------------------------------------------------------
// The generic built-in object resolver
// ---------------------------------------------------------------------------

function builtInSpec(
	productId: string,
): Omit<KubernetesResolverSpec, "productId"> {
	const selected = OBJECT_KINDS[productId];
	if (selected === undefined) {
		throw new Error(`unknown kubernetes object product ${productId}`);
	}
	const kind = selected;

	// SAFETY: assertion to ` async function read( context: Kube` is required at this boundary.
	async function read(
		context: KubernetesResolverContext,
	): Promise<JsonObject | undefined> {
		const label = `kubernetes read ${kind.kind} ${context.namespace}/${context.name}`;
		const response = await send(context, {
			method: "GET",
			path: objectPath(kind, context),
		});
		if (isNotFound(response)) return undefined;
		return expectOk(response, label);
	}

	return {
		async read(context) {
			const observed = await read(context);
			return observed === undefined
				? undefined
				: outcome(
						settledAction(context),
						`${context.namespace}/${context.name}`,
						objectOutputs(kind, context, observed),
						[],
					);
		},
		async reconcile(context) {
			const spec = desiredSpec(context, productId);
			const observed = await read(context);
			if (observed === undefined) {
				const label = `kubernetes create ${kind.kind} ${context.namespace}/${context.name}`;
				const created = expectOk(
					await send(context, {
						method: "POST",
						path: collectionPath(kind, context),
						json: objectBody(kind, context, spec),
					}),
					label,
				);
				return outcome(
					"create",
					`${context.namespace}/${context.name}`,
					objectOutputs(kind, context, created),
					[
						`the ${kind.kind} was accepted by the apiserver; scheduling and rollout happen asynchronously and this resolver does not watch, so the object exists but the workload is accepted, not confirmed`,
					],
				);
			}
			if (stableJson(nestedRecord(observed, "spec")) === stableJson(spec)) {
				return outcome(
					settledAction(context),
					`${context.namespace}/${context.name}`,
					objectOutputs(kind, context, observed),
					[],
				);
			}
			if (kind.specImmutable) {
				return outcome(
					settledAction(context),
					`${context.namespace}/${context.name}`,
					objectOutputs(kind, context, observed),
					driftDiagnostics(kind, observed, spec),
				);
			}
			// A strategic-merge patch would merge list items by key and silently
			// keep containers the new spec dropped. A plain merge patch replaces
			// the spec wholesale, which is what "the spec you authored is the
			// spec that runs" actually requires.
			const label = `kubernetes patch ${kind.kind} ${context.namespace}/${context.name}`;
			const patched = expectOk(
				await send(context, {
					method: "PATCH",
					path: objectPath(kind, context),
					contentType: "application/merge-patch+json",
					json: { spec },
				}),
				label,
			);
			return outcome(
				"update",
				`${context.namespace}/${context.name}`,
				objectOutputs(kind, context, patched),
				[
					`the ${kind.kind}'s spec was replaced; the rollout it triggers is asynchronous and this resolver does not watch it, so the change is requested, not confirmed`,
				],
			);
		},
		async remove(context) {
			const label = `kubernetes delete ${kind.kind} ${context.namespace}/${context.name}`;
			const response = await send(context, {
				method: "DELETE",
				path: objectPath(kind, context),
			});
			if (isNotFound(response)) return;
			expectOk(response, label);
		},
	};
}

// ---------------------------------------------------------------------------
// Secret — material that never touches `desired`, an output, or a diagnostic
// ---------------------------------------------------------------------------

/**
 * A Secret is the one catalogued object whose *content* is the material.
 *
 * That is a real constraint, and the wrong conclusion to draw from it is that
 * the object cannot be resolved. `desired` is what must stay clean, not the
 * request: core refuses credential-shaped keys in a property bag for exactly
 * this reason, so the contents arrive through the injected
 * `resolveSecretData(logicalId)` — the same shape as every other credential in
 * this repo — and `desired` carries only the Secret's `type` and its labels.
 *
 * From there the discipline is mechanical, and each piece is tested:
 *
 *   - material is fetched immediately before the call and held no longer;
 *   - it goes into the request body and nowhere else — never an output, never a
 *     diagnostic, never a URL, never an error message;
 *   - outputs publish the *key names* and the type, because a binding needs to
 *     know a Secret has a `password` key, and never the values;
 *   - drift is decided by comparing encoded values in memory, so a rotation
 *     converges without either version being rendered anywhere.
 */
// SAFETY: assertion to `jectKind; /** * Base64 of the UTF-8 bytes, which is wh` is required at this boundary.
const SECRET_KIND = OBJECT_KINDS[KUBERNETES_SECRET_PRODUCT_ID] as ObjectKind;

/**
 * Base64 of the UTF-8 bytes, which is what the apiserver stores in `data`.
 *
 * `btoa` alone is latin1 and would corrupt any non-ASCII secret, so the string
 * is encoded to bytes first. Built on globals rather than `node:buffer` because
 * this package also runs in `@hobo/runtime-browser`.
 */
function base64Utf8(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** The Secret's `type`, defaulted to the one Kubernetes itself defaults to. */
function secretType(context: KubernetesResolverContext): string {
	return optionalString(context.desired, "secretType") ?? "Opaque";
}

/**
 * Fetch the Secret's contents from the host's custody.
 *
 * The return value is deliberately not stored on the context: it is fetched at
 * the point of use so that a `read` — which never needs material — never causes
 * the host's custody to be touched at all.
 */
async function secretData(
	context: KubernetesResolverContext,
): Promise<Readonly<Record<string, string>>> {
	const resolve = context.resolveSecretData;
	if (resolve === undefined) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`${KUBERNETES_SECRET_PRODUCT_ID}: no Secret data resolver was injected. Construct the resolvers with resolveSecretData(logicalId) — a Secret's contents are material, they cannot travel in desired (core refuses credential-shaped keys in a property bag, because desired is recorded in the event log), and this resolver will not create an empty Secret, because a workload mounting one would fail at runtime rather than here`,
			KUBERNETES_SECRET_PRODUCT_ID,
		);
	}
	const material = await resolve(context.request.ref.logicalId);
	if (material === null || !isJsonObject(material)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`${KUBERNETES_SECRET_PRODUCT_ID}: resolveSecretData did not return an object of string values for ${JSON.stringify(context.request.ref.logicalId)}`,
			KUBERNETES_SECRET_PRODUCT_ID,
		);
	}
	const entries = Object.entries(material);
	if (entries.length === 0) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`${KUBERNETES_SECRET_PRODUCT_ID}: resolveSecretData returned no keys for ${JSON.stringify(context.request.ref.logicalId)}. An empty Secret is accepted by the apiserver and fails at mount time instead, which is a worse place to find out`,
			KUBERNETES_SECRET_PRODUCT_ID,
		);
	}
	for (const [key, value] of entries) {
		if (!isJsonString(value)) {
			throw new ResolverError(
				"RESOLVER_CREDENTIAL_MISSING",
				// The key name is safe to print; the value is not, and is not.
				`${KUBERNETES_SECRET_PRODUCT_ID}: resolveSecretData returned a non-string for key ${JSON.stringify(key)}. Kubernetes stores byte strings, so the host's custody must hand over strings`,
				KUBERNETES_SECRET_PRODUCT_ID,
			);
		}
	}
	return Object.freeze({ ...material });
}

/** `{ key: base64(value) }`, which is exactly the apiserver's `data` shape. */
function encodedData(material: StringBag): StringBag {
	const out: StringBag = {};
	for (const key of Object.keys(material).sort(compareStrings)) {
		out[key] = base64Utf8(material[key] ?? "");
	}
	return out;
}

/**
 // SAFETY: assertion to `tputs: what a binding n` is required at this boundary.
 * Outputs: what a binding needs to *use* the Secret, and nothing more.
 *
 * The key names are published because a projection has to name a key to mount
 * it, and a binding that had to guess would be worse. The values are not, and
 * neither is anything derived from them.
 */
function secretOutputs(
	context: KubernetesResolverContext,
	observed: JsonObject,
): JsonObject {
	const data = nestedRecord(observed, "data");
	return {
		...objectOutputs(SECRET_KIND, context, observed),
		// Deliberately not named `secretType`/`secretRef`: core refuses
		// credential-shaped keys in an outcome's outputs as well as in `desired`,
		// and it is right to — a bag that can hold a key called `secret…` is a
		// bag someone will eventually put a secret in.
		objectType: optionalString(observed, "type") ?? secretType(context),
		keys: Object.keys(data).sort(compareStrings),
		/** The locator a `secret-ref` binding projects from. */
		locator: `k8s://${context.namespace}/${context.name}`,
	};
}

const SECRET_SPEC: Omit<KubernetesResolverSpec, "productId"> = {
	async read(context) {
		const label = `kubernetes read Secret ${context.namespace}/${context.name}`;
		const response = await send(context, {
			method: "GET",
			path: objectPath(SECRET_KIND, context),
		});
		if (isNotFound(response)) return undefined;
		const observed = expectOk(response, label);
		return outcome(
			settledAction(context),
			`${context.namespace}/${context.name}`,
			secretOutputs(context, observed),
			[],
		);
	},
	async reconcile(context) {
		const label = `kubernetes read Secret ${context.namespace}/${context.name}`;
		const existing = await send(context, {
			method: "GET",
			path: objectPath(SECRET_KIND, context),
		});
		const observed = isNotFound(existing)
			? undefined
			: expectOk(existing, label);
		// Material is fetched only now — after the read that might have made it
		// unnecessary is done, and only on a path that will actually send it.
		const wanted = encodedData(await secretData(context));
		const labels = desiredLabels(context);
		const body = {
			apiVersion: SECRET_KIND.apiVersion,
			kind: SECRET_KIND.kind,
			metadata: {
				name: context.name,
				namespace: context.namespace,
				...(Object.keys(labels).length > 0 ? { labels } : undefined),
			},
			type: secretType(context),
			data: wanted,
		};
		if (observed === undefined) {
			const created = expectOk(
				await send(context, {
					method: "POST",
					path: collectionPath(SECRET_KIND, context),
					json: body,
				}),
				`kubernetes create Secret ${context.namespace}/${context.name}`,
			);
			return outcome(
				"create",
				`${context.namespace}/${context.name}`,
				secretOutputs(context, created),
				[
					"the contents came from the injected resolveSecretData and are not in desired, in an output, or in this diagnostic; only the key names are published, because a projection has to name a key to mount it",
				],
			);
		}
		// Drift is decided on the encoded values, compared in memory. Neither
		// version is rendered into a message, so a rotation converges without
		// either secret being written anywhere.
		const live = nestedRecord(observed, "data");
		const settled =
			stableJson(live) === stableJson(wanted) &&
			(optionalString(observed, "type") ?? secretType(context)) ===
				secretType(context);
		if (settled) {
			return outcome(
				settledAction(context),
				`${context.namespace}/${context.name}`,
				secretOutputs(context, observed),
				[],
			);
		}
		if (
			(optionalString(observed, "type") ?? secretType(context)) !==
			secretType(context)
		) {
			// `type` is immutable on a Secret; the apiserver rejects a patch that
			// changes it. Reporting drift beats a request that cannot succeed.
			return outcome(
				settledAction(context),
				`${context.namespace}/${context.name}`,
				secretOutputs(context, observed),
				[
					`the live Secret's type is ${JSON.stringify(optionalString(observed, "type") ?? "")} and the request asks for ${JSON.stringify(secretType(context))}; a Secret's type is immutable, so converging it means deleting the object, which this resolver will not do to a Secret something may be mounting right now`,
				],
			);
		}
		const patched = expectOk(
			await send(context, {
				method: "PATCH",
				path: objectPath(SECRET_KIND, context),
				contentType: "application/merge-patch+json",
				// A merge patch on `data` replaces the map wholesale, which is what
				// a rotation means. A strategic-merge patch would keep keys the new
				// material dropped, leaving a retired credential mounted.
				json: { data: wanted },
			}),
			`kubernetes patch Secret ${context.namespace}/${context.name}`,
		);
		return outcome(
			"update",
			`${context.namespace}/${context.name}`,
			secretOutputs(context, patched),
			[
				"the Secret's contents were replaced; which keys or values changed is deliberately not reported, because a diagnostic is written to the event log",
				"a running pod that mounted this Secret as a volume sees the new value within the kubelet's sync period; one that consumed it through env vars does not, and needs a restart this resolver does not perform",
			],
		);
	},
	async remove(context) {
		const response = await send(context, {
			method: "DELETE",
			path: objectPath(SECRET_KIND, context),
		});
		if (isNotFound(response)) return;
		expectOk(
			response,
			`kubernetes delete Secret ${context.namespace}/${context.name}`,
		);
	},
};

// ---------------------------------------------------------------------------
// Wrapper and registry
// ---------------------------------------------------------------------------

/** Per-product behaviour; the wrapper owns credentials, naming, and refusals. */
interface KubernetesResolverSpec {
	readonly productId: string;
	reconcile(context: KubernetesResolverContext): Promise<ResolveOutcome>;
	read(context: KubernetesResolverContext): Promise<ResolveOutcome | undefined>;
	remove(context: KubernetesResolverContext): Promise<void>;
}

function createResolver(
	spec: KubernetesResolverSpec,
	options: KubernetesResolverOptions,
): ResourceResolver {
	// Parses (and refuses) the apiserver URL at construction time rather than
	// on the first call, when a token is already in hand.
	parseApiServerEndpoint(options.apiServerUrl);
	if (!(options.resolveCredential instanceof Function)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			"kubernetes resolvers need an injected resolveCredential(ref): the resolver never reads a kubeconfig or a projected token file itself",
		);
	}

	async function contextFor(
		request: ResolveRequest,
		transport: HttpTransport,
	): Promise<KubernetesResolverContext> {
		if (request.ref.productId !== spec.productId) {
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`kubernetes resolver for ${spec.productId} was handed a request for ${JSON.stringify(request.ref.productId)}; route the request through the registry rather than picking a resolver by hand`,
				spec.productId,
			);
		}
		const name = objectName(request, spec.productId);
		const namespace = requiredNamespace(request, spec.productId);
		const physicalId = knownPhysicalId(request);
		if (physicalId !== undefined && physicalId !== `${namespace}/${name}`) {
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				"the desired Kubernetes location differs from the recorded physical identity; an existing resource cannot be retargeted",
			);
		}
		const token = await resolveToken(request, options.resolveCredential);
		return {
			request,
			transport,
			token,
			apiServerUrl: options.apiServerUrl,
			name,
			namespace,
			desired: request.desired,
			knownPhysicalId: physicalId,
			resolveSecretData:
				spec.productId === KUBERNETES_SECRET_PRODUCT_ID
					? options.resolveSecretData
					: undefined,
		};
	}

	return {
		providerId: PROVIDER_TARGET,
		productId: spec.productId,
		async reconcile(request, transport) {
			return spec.reconcile(await contextFor(request, transport));
		},
		async read(request, transport) {
			return spec.read(await contextFor(request, transport));
		},
		async delete(request, transport) {
			await spec.remove(await contextFor(request, transport));
		},
	};
}

/**
 * Every Kubernetes resolver, id-sorted so the list is a function of the code
 * rather than of construction order. Every catalogued object has one;
 * {@link KUBERNETES_UNRESOLVED_PRODUCT_IDS} is empty and stays exported so that
 * stops being true loudly rather than quietly.
 */
export function kubernetesResolvers(
	options: KubernetesResolverOptions,
): readonly ResourceResolver[] {
	return Object.freeze(
		[...KUBERNETES_RESOLVED_PRODUCT_IDS].sort(compareStrings).map((productId) =>
			createResolver(
				{
					productId,
					...(productId === KUBERNETES_SECRET_PRODUCT_ID
						? SECRET_SPEC
						: builtInSpec(productId)),
				},
				options,
			),
		),
	);
}

/** The same resolvers, behind core's product-id lookup. */
export function kubernetesResolverRegistry(
	options: KubernetesResolverOptions,
): {
	get(productId: string): ResourceResolver | undefined;
	list(): readonly ResourceResolver[];
} {
	return createResolverRegistry(kubernetesResolvers(options));
}
