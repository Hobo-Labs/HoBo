/**
 * Direct Hostinger API resource resolvers — the default deployment path.
 *
 * Why this module exists, and what makes it different from the other provider
 * packages: on AWS, GCP, DigitalOcean and Hetzner, "allocate a resource" is an
 * API call. **On Hostinger it is a purchase.** A VPS, a hosting plan and the
 * MySQL database that comes with it are all obtained by placing a billing
 * order; the API manages instances you already own. That is not a gap in
 * Hostinger's API, it is the shape of the product, and this module is written
 * around it rather than pretending otherwise.
 *
 * So these resolvers **adopt and converge**. `reconcile()` finds the instance
 * you already bought, brings its mutable state to what the request asks for,
 * and reports what it found. When there is nothing to adopt it raises a typed
 * refusal naming the purchase as the missing step — it does not place the
 * order. That refusal is enforced by the transport, not just by this code: the
 * guard in `./transport.ts` does not allowlist `/api/billing/v1/`, so a future
 * edit here cannot quietly start spending the account's money without also
 * widening the policy in a way a reviewer sees.
 *
 * Everything else is the usual convergence contract. `reconcile()` reads before
 * it writes, running it twice yields the same `physicalId` and exactly one
 * mutation, `delete()` treats "already gone" as success, and `"replace"` is
 * never emitted — reinstalling a VPS destroys its disk, so drift on an
 * immutable field is reported as a diagnostic and left for a human.
 *
 * One thing this module refuses on purpose: a root password in `desired`.
 * Hostinger's VPS setup call accepts one, and accepting it here would put
 * credential material in a `ResolveRequest`, which is material in the event
 * log. Setup is expressed with an SSH public-key *id* instead — a reference to
 * a key already uploaded to the account, which is a locator rather than a
 * secret.
 *
 * Credentials are locators, never material. A resolver is constructed with an
 * injected `resolveCredential(ref)`; `ResolveRequest.credentialRef` must be a
 * `scheme://…` locator — the grammar core's `parseResolveRequest` enforces —
 * and a value that looks like the API token itself is refused. The token
 * reaches exactly one place: the `authorization` header. It is never logged,
 * never put in `outputs`, and Hostinger's error text is redacted before it
 * reaches a message.
 *
 * Determinism: no clock, no randomness, no environment reads.
 *
 * HONEST SCOPE (also in the README):
 *   - These resolvers are exercised against an *injected fake* transport
 *     modelling a Hostinger account. Nothing in this package proves a live
 *     deploy: that additionally needs a real token, real network egress, and a
 *     real Hostinger account with plans already purchased.
 *   - The endpoint paths, request bodies and response field names below are
 *     written from Hostinger's published API reference. They have not been
 *     replayed against the running service, so a field Hostinger has since
 *     renamed would fail at deploy time, not here.
 *   - 2 of the 5 catalogued products have resolvers. The other three are named
 *     in {@link HOSTINGER_UNRESOLVED_PRODUCT_IDS} with the reason.
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

import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonObject,
} from "./json.js";
import { HOSTINGER_PROVIDER_TARGET } from "./options.js";
import { dnsZone, mysql, staticSite, vps, webHosting } from "./slots.js";
import {
	guardedHostingerTransport,
	HOSTINGER_MAX_RESPONSE_BYTES,
	HOSTINGER_MAX_TIMEOUT_MS,
	hostingerApiUrl,
} from "./transport.js";

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

export const HOSTINGER_VPS_PRODUCT_ID = productIdOf(vps(), "vps");
export const HOSTINGER_DNS_ZONE_PRODUCT_ID = productIdOf(dnsZone(), "dnsZone");
export const HOSTINGER_WEB_HOSTING_PRODUCT_ID = productIdOf(
	webHosting(),
	"webHosting",
);
export const HOSTINGER_STATIC_SITE_PRODUCT_ID = productIdOf(
	staticSite(),
	"staticSite",
);
export const HOSTINGER_MYSQL_PRODUCT_ID = productIdOf(mysql(), "mysql");

/** Every product this module resolves, id-sorted for a deterministic registry. */
export const HOSTINGER_RESOLVED_PRODUCT_IDS: readonly string[] = Object.freeze(
	[
		HOSTINGER_DNS_ZONE_PRODUCT_ID,
		HOSTINGER_MYSQL_PRODUCT_ID,
		HOSTINGER_STATIC_SITE_PRODUCT_ID,
		HOSTINGER_VPS_PRODUCT_ID,
		HOSTINGER_WEB_HOSTING_PRODUCT_ID,
	].sort(compareStrings),
);

/**
 * Product ids this package catalogs but does not resolve.
 *
 * Empty. Every product in the Hostinger catalog has a convergent path on
 * `/api/hosting/v1/`, `/api/vps/v1/` or `/api/dns/v1/`.
 *
 * It is exported anyway, and the tests still assert that resolved + unresolved
 * accounts for the catalog exactly once. The list existing and being empty is a
 * different claim from the list not existing: a product added to `./slots.ts`
 * without a resolver has to be named here, and that is a decision a reviewer
 * sees rather than a gap nobody counted.
 */
export const HOSTINGER_UNRESOLVED_PRODUCT_IDS: readonly string[] =
	Object.freeze([]);

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** What a host must supply to build the resolvers. */
export interface HostingerResolverOptions {
	/**
	 * Resolves a credential *locator* to a Hostinger account API token.
	 * Injected so the resolver never holds a secret and never decides where
	 * secrets live.
	 */
	readonly resolveCredential: (ref: string) => Promise<string>;
	/**
	 * Resolves the password for one MySQL database user, by logical id.
	 *
	 * Keyed by logical id rather than by anything in `desired`, because core
	 * refuses credential-shaped keys in a property bag: `desired` is recorded in
	 * the event log, and the safest thing to write there about a password is
	 * nothing at all. Hostinger mints a database user at create time and demands
	 * its password in the same call, so the host maps the logical id to its own
	 * custody. Required only to build the MySQL resolver.
	 */
	readonly resolveDatabasePassword?: (logicalId: string) => Promise<string>;
}

/**
 * A credential locator, using the same grammar core's `parseResolveRequest`
 * enforces (`scheme://path`, no userinfo). Restated here rather than imported
 * because a resolver must refuse a bad ref even when a caller skipped the parse
 * boundary — and a second grammar would be a second answer.
 */
const CREDENTIAL_REF_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^\s@]+$/u;

/**
 * What a Hostinger API token looks like when someone pastes the value into
 * `credentialRef` by mistake. Refusing this shape is the difference between a
 * locator in the event log and a live token in the event log.
 */
const RAW_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{32,}$/u;

/** Anything long and token-shaped is scrubbed out of provider error text. */
const TOKEN_PATTERN = /[A-Za-z0-9_-]{20,}/gu;

/**
 * Property names that carry a secret rather than a reference to one. A request
 * carrying any of these is refused before a call is made — see
 * {@link refuseInlineSecrets}.
 */
const INLINE_SECRET_KEYS = Object.freeze([
	"password",
	"rootPassword",
	"privateKey",
	"sshPrivateKey",
] as const);

/**
 * Redact provider text before it reaches a message, a diagnostic, or a log.
 * Hostinger echoes request context in its error bodies, and that context has
 * carried hostnames and token fragments before.
 */
export function redactHostingerText(text: string, limit = 400): string {
	const scrubbed = text.replace(TOKEN_PATTERN, "[redacted]");
	return scrubbed.length > limit ? `${scrubbed.slice(0, limit)}…` : scrubbed;
}

// ---------------------------------------------------------------------------
// Small shared parsers
// ---------------------------------------------------------------------------

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function optionalString(record: JsonObject, key: string): string | undefined {
	const value = record[key];
	return isJsonString(value) && value.trim().length > 0 ? value : undefined;
}

function optionalInteger(record: JsonObject, key: string): number | undefined {
	const value = record[key];
	return isJsonNumber(value) && Number.isSafeInteger(value) ? value : undefined;
}

function nestedRecord(record: JsonObject, key: string): JsonObject {
	const value = record[key];
	return isJsonObject(value) ? value : {};
}

/** Hostinger ids are integers on every resource this module touches. */
function identityOf(record: JsonObject, label: string): string {
	const value = record.id;
	if (isJsonNumber(value) && Number.isSafeInteger(value)) {
		return String(value);
	}
	if (isJsonString(value) && value.trim().length > 0) return value;
	throw new ResolverError(
		"RESOLVER_OUTPUT_UNPARSEABLE",
		`${label}: Hostinger returned a record without a usable id, so the resource cannot be addressed`,
	);
}

/** Key-sorted JSON, so a record-set compare does not depend on key order. */
function stableJson(value: JsonValue): string {
	if (isJsonArray(value)) {
		return `[${value.map((item) => stableJson(item)).join(",")}]`;
	}
	if (isJsonObject(value)) {
		return `{${Object.keys(value)
			.sort(compareStrings)
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key] ?? null)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

interface HostingerCall {
	readonly method: TransportMethod;
	/** Host-relative, with every dynamic segment already encoded. */
	readonly path: string;
	readonly json?: unknown;
}

/**
 * Send one call, through the guard. The guard is applied here rather than left
 * to the caller: an unguarded transport slipping through would be a
 * legal-TypeScript security defect, and the token is in the header of every one
 * of these requests.
 */
async function send(
	context: HostingerResolverContext,
	call: HostingerCall,
): Promise<TransportResponse> {
	const body = call.json === undefined ? undefined : JSON.stringify(call.json);
	const guarded = guardedHostingerTransport(context.transport);
	return guarded({
		method: call.method,
		url: hostingerApiUrl(call.path),
		headers: {
			accept: "application/json",
			authorization: `Bearer ${context.token}`,
			...(body !== undefined
				? { "content-type": "application/json" }
				: undefined),
		},
		...(body !== undefined ? { body } : undefined),
		timeoutMs: HOSTINGER_MAX_TIMEOUT_MS,
		maxResponseBytes: HOSTINGER_MAX_RESPONSE_BYTES,
	});
}

function isNotFound(response: TransportResponse): boolean {
	return response.status === 404;
}

/**
 * Parse a JSON body into a record or a list. An empty body on a success status
 * is `{}`, and anything else that is not JSON is `RESOLVER_OUTPUT_UNPARSEABLE`,
 * because a body this code cannot read leaves the outcome of the call unknown,
 * and an unknown outcome is refused rather than assumed.
 */
function parseJson(response: TransportResponse, label: string): JsonValue {
	if (response.body.trim().length === 0) return {};
	try {
		// SAFETY: JSON.parse yields a JSON value at this document boundary.
		return JSON.parse(response.body) as JsonValue;
	} catch {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: Hostinger returned a status ${response.status} body that is not JSON, so the outcome of the call is unknown and it is refused rather than assumed`,
		);
	}
}

/**
 * The refusal path. Hostinger's error envelope is
 * `{"message":"…","errors":{…}}`; the message is redacted before it is quoted,
 * because provider text is the most common way a token fragment or a caller's
 * private path reaches a log.
 */
function providerRejection(
	response: TransportResponse,
	label: string,
): ResolverError {
	let detail = "no error detail was returned";
	try {
		const parsed = parseJson(response, label);
		const message = isJsonObject(parsed)
			? optionalString(parsed, "message")
			: undefined;
		if (message !== undefined) detail = redactHostingerText(message);
	} catch {
		const snippet = response.body.trim();
		if (snippet.length > 0) detail = redactHostingerText(snippet, 160);
	}
	return new ResolverError(
		"RESOLVER_PROVIDER_REJECTED",
		`${label}: Hostinger refused the call with status ${response.status}: ${detail}`,
	);
}

/** A successful response as a record; any 4xx/5xx is a typed refusal. */
function expectRecord(response: TransportResponse, label: string): JsonObject {
	if (response.status >= 400) throw providerRejection(response, label);
	const parsed = parseJson(response, label);
	if (!isJsonObject(parsed)) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: Hostinger returned JSON that is not an object, so the resource it describes cannot be identified`,
		);
	}
	return parsed;
}

/**
 * A successful response as a list. Hostinger answers some collections with a
 * bare array and others with `{data: [...]}`; both are accepted, and anything
 * else is refused rather than coerced.
 */
function expectList(
	response: TransportResponse,
	label: string,
): readonly JsonObject[] {
	if (response.status >= 400) throw providerRejection(response, label);
	const parsed = parseJson(response, label);
	const items = isJsonArray(parsed)
		? parsed
		: isJsonObject(parsed) && isJsonArray(parsed.data)
			? parsed.data
			: undefined;
	if (items === undefined) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: Hostinger returned neither an array nor a {data: [...]} envelope, so the collection cannot be searched and a mutation would risk acting on the wrong resource`,
		);
	}
	if (items.some((item) => !isJsonObject(item)))
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: an incomplete collection record cannot establish absence`,
		);
	if (isJsonObject(parsed)) {
		const links = nestedRecord(parsed, "links"),
			meta = nestedRecord(parsed, "meta");
		const next = optionalString(links, "next"),
			current = optionalInteger(meta, "current_page"),
			last = optionalInteger(meta, "last_page");
		if (
			next !== undefined ||
			(current !== undefined && last !== undefined && current < last)
		)
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				`${label}: a partial listing cannot establish absence or uniqueness; use the pinned physical identity`,
			);
	}
	return items.filter(isJsonObject);
}

// ---------------------------------------------------------------------------
// Resolver plumbing
// ---------------------------------------------------------------------------

/** Everything a resolver body needs, with the credential already resolved. */
interface HostingerResolverContext {
	readonly request: ResolveRequest;
	readonly transport: HttpTransport;
	readonly token: string;
	/** The deterministic resource name: `desired.name`, else the logical id. */
	readonly name: string;
	readonly desired: JsonObject;
	/** True when the caller already knows the physical id (adopt vs noop). */
	readonly knownPhysicalId: string | undefined;
	/**
	 * The host's database-password custody, if it wired one. A function rather
	 * than a resolved string so nothing is fetched for a request that does not
	 * need it, and so material never sits on a context that gets passed around.
	 * Undefined on every path but MySQL.
	 */
	readonly resolveDatabasePassword:
		| ((logicalId: string) => Promise<string>)
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
 * Existing resource, no delta: `noop` when the caller already named it, `adopt`
 * when the resolver found something the request did not know about. On this
 * provider `adopt` is the *normal* outcome rather than an edge case, because
 * every resource here was bought before HoBo saw it.
 */
function settledAction(context: HostingerResolverContext): ResolverAction {
	return context.knownPhysicalId === undefined ? "adopt" : "noop";
}

/**
 * Refuse a request that carries a secret inline. Hostinger's setup call accepts
 * a root password, and accepting one here would put credential material in a
 * `ResolveRequest` — which is material in the event log, permanently, whatever
 * the caller intended.
 */
function refuseInlineSecrets(
	context: HostingerResolverContext,
	productId: string,
): void {
	for (const key of INLINE_SECRET_KEYS) {
		if (context.desired[key] !== undefined) {
			throw new ResolverError(
				"RESOLVER_CREDENTIAL_NOT_A_REF",
				`${productId}: desired.${key} carries credential material. A ResolveRequest is recorded in the event log, so a password in it is a password in the log — upload an SSH key to the Hostinger account and pass desired.publicKeyId instead, which is a reference rather than a secret`,
			);
		}
	}
}

/**
 * The credential parse boundary. A blank ref is `RESOLVER_CREDENTIAL_MISSING`
 * (with remediation), a token-shaped one is `RESOLVER_CREDENTIAL_NOT_A_REF` — a
 * raw secret in a request record has already leaked by the time it is used —
 * and a host that hands back nothing is missing, never "carry on
 * unauthenticated", which would surface at Hostinger as a confusing 401.
 */
async function resolveToken(
	request: ResolveRequest,
	resolve: (ref: string) => Promise<string>,
): Promise<string> {
	const ref = request.credentialRef;
	if (ref.trim().length === 0) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			'hostinger resolver: credentialRef is empty. Supply a locator such as "env://HOSTINGER_API_TOKEN" or "secret://camp/hostinger-token" and register it with the host credential resolver; the resolver never accepts inline credential material',
		);
	}
	const trimmed = ref.trim();
	if (RAW_CREDENTIAL_PATTERN.test(trimmed)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			"hostinger resolver: credentialRef looks like credential material rather than a locator. Store the API token with the host secret custody and pass its reference (scheme://path); a raw token in a ResolveRequest is a token in the event log",
		);
	}
	if (!CREDENTIAL_REF_PATTERN.test(trimmed)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			`hostinger resolver: credentialRef ${JSON.stringify(redactHostingerText(trimmed, 60))} is not a locator. Expected "<scheme>://<path>", for example "env://HOSTINGER_API_TOKEN"`,
		);
	}
	let material: string;
	try {
		material = await resolve(trimmed);
	} catch (cause) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`hostinger resolver: the host could not resolve credentialRef ${JSON.stringify(trimmed)}: ${redactHostingerText(
				cause instanceof Error ? cause.message : String(cause),
				160,
			)}. Register the reference with the credential resolver before deploying`,
		);
	}
	if (material.trim().length === 0) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`hostinger resolver: credentialRef ${JSON.stringify(trimmed)} resolved to nothing. A missing credential is refused rather than retried unauthenticated, which would look like a permissions error at Hostinger`,
		);
	}
	return material.trim();
}

function resourceName(request: ResolveRequest, productId: string): string {
	const desiredName = optionalString(
		parseJsonObject(JSON.stringify(request.desired)),
		"name",
	);
	if (desiredName !== undefined) return desiredName;
	const logicalId = request.ref.logicalId;
	if (logicalId.trim().length > 0) {
		return logicalId;
	}
	throw new ResolverError(
		"RESOLVER_PRODUCT_UNSUPPORTED",
		`${productId}: the request names no resource — set desired.name or ref.logicalId. The name is what makes reconcile convergent, so it is never generated here`,
	);
}

/** The physical id the caller already knows, if it supplied a usable one. */
function knownPhysicalId(request: ResolveRequest): string | undefined {
	const value = request.ref.physicalId;
	return value !== undefined && value.trim().length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// VPS — /api/vps/v1/virtual-machines
// ---------------------------------------------------------------------------

const VIRTUAL_MACHINES = "/api/vps/v1/virtual-machines";

/** A VPS that has been bought but has no OS on it yet. */
const UNPROVISIONED_STATES = Object.freeze(["initial", "created"] as const);

function vpsOutputs(record: JsonObject): JsonObject {
	const addresses = isJsonArray(record.ipv4) ? record.ipv4 : [];
	const first = addresses.filter(isJsonObject)[0];
	const hostname = optionalString(record, "hostname");
	const state = optionalString(record, "state");
	const ipv4 =
		first === undefined ? undefined : optionalString(first, "address");
	const template = optionalString(nestedRecord(record, "template"), "name");
	const dataCentre = optionalString(
		nestedRecord(record, "data_center"),
		"name",
	);
	return {
		ready: state === "running",
		operationConfirmed: state === "running",
		...(hostname !== undefined ? { hostname } : undefined),
		...(state !== undefined ? { state } : undefined),
		...(ipv4 !== undefined ? { ipv4 } : undefined),
		...(template !== undefined ? { template } : undefined),
		...(dataCentre !== undefined ? { dataCenter: dataCentre } : undefined),
	};
}

function vpsDiagnostics(
	context: HostingerResolverContext,
	record: JsonObject,
): readonly string[] {
	const diagnostics: string[] = [];
	const state = optionalString(record, "state");
	if (state !== undefined && state !== "running") {
		diagnostics.push(
			`virtual machine is ${state}, not running: Hostinger provisions asynchronously and this resolver does not poll, so the call is accepted, not confirmed`,
		);
	}
	const wantedTemplate = optionalString(context.desired, "template");
	const actualTemplate = optionalString(
		nestedRecord(record, "template"),
		"name",
	);
	if (
		wantedTemplate !== undefined &&
		actualTemplate !== undefined &&
		wantedTemplate !== actualTemplate
	) {
		diagnostics.push(
			`virtual machine runs template ${actualTemplate} but the request asks for ${wantedTemplate}; changing it means a recreate, which wipes the disk — this resolver never does that on its own, so the drift is reported for a human`,
		);
	}
	return diagnostics;
}

/** Find the machine whose hostname is this resource's name. */
async function findVpsByHostname(
	context: HostingerResolverContext,
): Promise<JsonObject | undefined> {
	if (context.knownPhysicalId !== undefined)
		return readVpsById(context, context.knownPhysicalId);
	const label = `hostinger list virtual machines for ${context.name}`;
	const machines = expectList(
		await send(context, { method: "GET", path: VIRTUAL_MACHINES }),
		label,
	);
	const matches = machines.filter(
		(machine) => optionalString(machine, "hostname") === context.name,
	);
	if (matches.length > 1) {
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			`hostinger virtual machines: more than one machine has hostname ${JSON.stringify(context.name)}. Hostinger does not enforce hostname uniqueness, and choosing one by listing order would make the managed resource depend on the order the API answered in; rename the duplicates or pass ref.physicalId`,
		);
	}
	return matches[0];
}

/** Read one machine by its id, or undefined when the account has no such id. */
async function readVpsById(
	context: HostingerResolverContext,
	id: string,
): Promise<JsonObject | undefined> {
	const label = `hostinger read virtual machine ${id}`;
	const response = await send(context, {
		method: "GET",
		path: `${VIRTUAL_MACHINES}/${encodeURIComponent(id)}`,
	});
	if (isNotFound(response)) return undefined;
	const record = expectRecord(response, label);
	// Hostinger wraps some single-resource reads in `{data: {...}}`.
	const resource = isJsonObject(record.data) ? record.data : record;
	if (identityOf(resource, label) !== id)
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: physical identity differs from the pinned resource`,
		);
	return resource;
}

/**
 * The refusal that carries this provider's whole shape: there is nothing to
 * adopt, and allocating one is a purchase this package will not make.
 */
function purchaseRequired(name: string): ResolverError {
	return new ResolverError(
		"RESOLVER_PRODUCT_UNSUPPORTED",
		`hostinger.vps/v1: no virtual machine in this account has hostname ${JSON.stringify(name)}, and none was named by desired.virtualMachineId. On Hostinger a VPS is allocated by placing a billing order, not by an API call — this resolver adopts and converges a machine you already own and will not spend the account's money to make one. Buy the plan, then set desired.virtualMachineId to the new instance (or set its hostname to ${JSON.stringify(name)}) and reconcile again. The transport guard does not allowlist /api/billing/v1/, so this refusal is enforced below this code, not just by it`,
	);
}

const VPS_SPEC: Omit<HostingerResolverSpec, "productId"> = {
	async read(context) {
		const observed = await findVpsByHostname(context);
		return observed === undefined
			? undefined
			: outcome(
					settledAction(context),
					identityOf(observed, `hostinger read virtual machine`),
					vpsOutputs(observed),
					vpsDiagnostics(context, observed),
				);
	},
	async reconcile(context) {
		const productId = HOSTINGER_VPS_PRODUCT_ID;
		refuseInlineSecrets(context, productId);

		const adopted = await findVpsByHostname(context);
		if (adopted !== undefined) {
			return outcome(
				settledAction(context),
				identityOf(adopted, "hostinger read virtual machine"),
				vpsOutputs(adopted),
				vpsDiagnostics(context, adopted),
			);
		}

		const named = optionalString(context.desired, "virtualMachineId");
		if (named === undefined) throw purchaseRequired(context.name);
		const machine = await readVpsById(context, named);
		if (machine === undefined) {
			throw new ResolverError(
				"RESOLVER_PROVIDER_REJECTED",
				`${productId}: desired.virtualMachineId ${JSON.stringify(named)} is not a machine in this account. A resolver that fell back to "create one" here would place a billing order, so it refuses instead`,
			);
		}

		const state = optionalString(machine, "state");
		const unprovisioned =
			state !== undefined &&
			UNPROVISIONED_STATES.some((entry) => entry === state);
		if (!unprovisioned) {
			// The machine is already running something. Setting it up again would
			// wipe the disk, so this converges the hostname only and reports the
			// rest — the same rule as every other immutable-drift path here.
			const renamed = await setHostname(context, named);
			return outcome("update", named, vpsOutputs(renamed), [
				...vpsDiagnostics(context, renamed),
				`machine ${named} was adopted by id and its hostname set to ${JSON.stringify(context.name)}; its OS was left alone, because re-running setup on a provisioned machine wipes the disk`,
			]);
		}

		const label = `hostinger set up virtual machine ${named}`;
		const publicKeyId = optionalInteger(context.desired, "publicKeyId");
		if (publicKeyId === undefined) {
			throw new ResolverError(
				"RESOLVER_CREDENTIAL_MISSING",
				`${productId}: setting up a virtual machine needs desired.publicKeyId — the id of an SSH key already uploaded to the Hostinger account. This resolver will not accept a root password, because a password in a ResolveRequest is a password in the event log`,
			);
		}
		expectRecord(
			await send(context, {
				method: "POST",
				path: `${VIRTUAL_MACHINES}/${encodeURIComponent(named)}/setup`,
				json: {
					hostname: context.name,
					template_id: optionalInteger(context.desired, "templateId"),
					data_center_id: optionalInteger(context.desired, "dataCenterId"),
					public_key: { id: publicKeyId },
				},
			}),
			label,
		);
		const provisioned = (await readVpsById(context, named)) ?? machine;
		return outcome("create", named, vpsOutputs(provisioned), [
			...vpsDiagnostics(context, provisioned),
			`setup was requested on the machine you already own; Hostinger installs the template asynchronously and this resolver does not poll, so the machine is accepted, not confirmed`,
		]);
	},
	async remove(context) {
		// Deliberately not a delete. Destroying a VPS on Hostinger means
		// cancelling a paid plan, which is a billing action; the API surface for
		// it is not allowlisted, and a resolver that could reach it could cancel
		// a service nobody asked it to.
		const observed = await findVpsByHostname(context);
		if (observed === undefined) return;
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`hostinger.vps/v1: this resolver will not remove virtual machine ${identityOf(observed, "hostinger read virtual machine")}. Destroying a Hostinger VPS means cancelling a paid plan — a billing action, on a surface the transport guard does not allowlist. Cancel the plan in hPanel; the resource will then be absent and a later reconcile will say so`,
		);
	},
};

/** Set the machine's hostname and read back what the account now holds. */
async function setHostname(
	context: HostingerResolverContext,
	id: string,
): Promise<JsonObject> {
	const label = `hostinger set hostname on virtual machine ${id}`;
	expectRecord(
		await send(context, {
			method: "PUT",
			path: `${VIRTUAL_MACHINES}/${encodeURIComponent(id)}/hostname`,
			json: { hostname: context.name },
		}),
		label,
	);
	const refreshed = await readVpsById(context, id);
	if (refreshed === undefined) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: the machine could not be read back after the rename, so what the account now holds is unknown and is refused rather than assumed`,
		);
	}
	return refreshed;
}

// ---------------------------------------------------------------------------
// DNS zones — /api/dns/v1/zones/{domain}
// ---------------------------------------------------------------------------

const DNS_ZONES = "/api/dns/v1/zones";

function zonePath(context: HostingerResolverContext): string {
	return `${DNS_ZONES}/${encodeURIComponent(context.name)}`;
}

/**
 * The record set the caller authored. Passed through rather than assembled
 * field by field: a zone carries A, AAAA, CNAME, MX, TXT, SRV and CAA records
 * with per-record TTLs, and a resolver that rebuilt a subset of that would
 * silently drop everything it did not know about on the next reconcile.
 */
function desiredZone(
	context: HostingerResolverContext,
	productId: string,
): readonly unknown[] {
	const records = context.desired.records;
	if (!isJsonArray(records)) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${productId}: the request carries no desired.records array. A DNS zone is defined by its record set; this resolver forwards the records you authored and owns only the domain they are written to, because inventing records would publish addresses nobody wrote`,
		);
	}
	return records;
}

function zoneOutputs(
	context: HostingerResolverContext,
	records: readonly JsonObject[],
): JsonObject {
	return {
		ready: true,
		domain: context.name,
		recordCount: records.length,
		recordTypes: [
			...new Set(
				records
					.map((entry) => optionalString(entry, "type"))
					.filter((entry): entry is string => entry !== undefined),
			),
		].sort(compareStrings),
	};
}

const DNS_ZONE_SPEC: Omit<HostingerResolverSpec, "productId"> = {
	async read(context) {
		const label = `hostinger read dns zone ${context.name}`;
		const response = await send(context, {
			method: "GET",
			path: zonePath(context),
		});
		if (isNotFound(response)) return undefined;
		const records = expectList(response, label);
		return outcome(
			settledAction(context),
			context.name,
			zoneOutputs(context, records),
			[],
		);
	},
	async reconcile(context) {
		const productId = HOSTINGER_DNS_ZONE_PRODUCT_ID;
		const wanted = desiredZone(context, productId);
		const label = `hostinger read dns zone ${context.name}`;
		const response = await send(context, {
			method: "GET",
			path: zonePath(context),
		});
		if (isNotFound(response)) {
			throw new ResolverError(
				"RESOLVER_PROVIDER_REJECTED",
				`${productId}: ${JSON.stringify(context.name)} is not a domain in this Hostinger account, so it has no zone to converge. A domain is acquired by purchase or transfer, which this resolver will not do — register or transfer the domain first, then reconcile`,
			);
		}
		const observed = expectList(response, label);
		if (
			stableJson(parseJsonObject(JSON.stringify({ items: observed }))) ===
			stableJson(parseJsonObject(JSON.stringify({ items: wanted })))
		) {
			return outcome(
				settledAction(context),
				context.name,
				zoneOutputs(context, observed),
				[],
			);
		}
		// Hostinger's zone PUT is a full replace, not a patch: a partial body
		// silently drops the records it omits, so the whole authored set is sent.
		const putLabel = `hostinger replace dns zone ${context.name}`;
		expectRecord(
			await send(context, {
				method: "PUT",
				path: zonePath(context),
				json: { overwrite: true, zone: wanted },
			}),
			putLabel,
		);
		const refreshed = expectList(
			await send(context, { method: "GET", path: zonePath(context) }),
			label,
		);
		return outcome("update", context.name, zoneOutputs(context, refreshed), [
			"the zone was replaced in full, because Hostinger's zone PUT drops any record the body omits; DNS propagation is not waited on here",
		]);
	},
	async remove(context) {
		// Hostinger has no "delete this zone" — a domain you own always has one —
		// so removal resets it to the provider default, and that is what the
		// diagnostic on the reconcile path would have said if it could.
		const label = `hostinger reset dns zone ${context.name}`;
		const response = await send(context, {
			method: "DELETE",
			path: zonePath(context),
		});
		if (isNotFound(response)) return;
		expectRecord(response, label);
	},
};

// ---------------------------------------------------------------------------
// Websites — a site inside a plan the account already owns
// ---------------------------------------------------------------------------

/**
 * `/api/hosting/v1/websites` is not the billing surface.
 *
 * `POST` takes an `order_id` — the plan the account already bought — and
 * refuses without one, so a resolver reaching this namespace can fill a plan it
 * was pointed at but cannot buy a new one. That is what makes widening the
 * guard to `/api/hosting/v1/` a different decision from widening it to
 * `/api/billing/v1/`, which stays excluded.
 */
const WEBSITES_PATH = "/api/hosting/v1/websites";

/** The domain this request is about: `desired.domain`, else the logical id. */
function websiteDomain(context: HostingerResolverContext): string {
	return optionalString(context.desired, "domain") ?? context.name;
}

/**
 * Find the site for one domain.
 *
 * The list endpoint takes an exact `?domain=` filter, so this is one bounded
 * call — no paging budget, and no chance of concluding "absent" from an
 * exhausted page count and then creating a duplicate.
 */
async function findWebsite(
	context: HostingerResolverContext,
): Promise<JsonObject | undefined> {
	const domain = websiteDomain(context);
	const label = `hostinger list websites for ${domain}`;
	const items = expectList(
		await send(context, {
			method: "GET",
			path: `${WEBSITES_PATH}?domain=${encodeURIComponent(domain)}`,
		}),
		label,
	);
	const matches = items
		.filter(isJsonObject)
		.filter((item) => optionalString(item, "domain") === domain);
	if (matches.length > 1) {
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			`hostinger websites: the exact domain filter for ${JSON.stringify(domain)} matched ${matches.length} records. A domain addresses one site on this API — DELETE takes the domain, not an id — so a second match means the filter did not behave as this resolver believes, and picking one by listing order would make the managed site depend on the order the API answered in`,
		);
	}
	return matches[0];
}

function websiteOutputs(observed: JsonObject): JsonObject {
	const username = optionalString(observed, "username");
	const vhostType = optionalString(observed, "vhost_type");
	const websiteType = optionalString(observed, "website_type");
	const root = optionalString(observed, "root_directory");
	const orderId = optionalInteger(observed, "order_id");
	return {
		ready: observed.is_enabled === true,
		domain: optionalString(observed, "domain") ?? "",
		url: `https://${optionalString(observed, "domain") ?? ""}`,
		...(username === undefined ? undefined : { hostingAccount: username }),
		...(vhostType === undefined ? undefined : { vhostType }),
		...(websiteType === undefined ? undefined : { websiteType }),
		...(root === undefined ? undefined : { documentRoot: root }),
		...(orderId === undefined ? undefined : { orderId }),
	};
}

function websiteDiagnostics(observed: JsonObject): readonly string[] {
	const diagnostics: string[] = [];
	if (observed.is_enabled === false) {
		diagnostics.push(
			"the site exists but Hostinger reports it disabled; requests to it will not be served until it is enabled, which this resolver does not do because a disabled site is usually a billing or abuse state rather than a config drift",
		);
	}
	return Object.freeze(diagnostics);
}

/**
 * Both website products resolve against the same resource.
 *
 * `hostinger.web-hosting/v1` and `hostinger.static-site/v1` are two capability
 * profiles over one thing Hostinger sells — a site on a plan. They are separate
 * catalog rows because a workload that only needs assets should be able to
 * match the narrower profile, and they share this spec because pretending the
 * provider has two resources would mean two resolvers racing over one domain.
 */
function websiteSpec(
	kind: "hosted" | "static",
): Omit<HostingerResolverSpec, "productId"> {
	const productId =
		kind === "static"
			? HOSTINGER_STATIC_SITE_PRODUCT_ID
			: HOSTINGER_WEB_HOSTING_PRODUCT_ID;
	return {
		async read(context) {
			const observed = await findWebsite(context);
			return observed === undefined
				? undefined
				: outcome(
						settledAction(context),
						websiteDomain(context),
						websiteOutputs(observed),
						websiteDiagnostics(observed),
					);
		},
		async reconcile(context) {
			refuseInlineSecrets(context, productId);
			const domain = websiteDomain(context);
			const observed = await findWebsite(context);
			if (observed !== undefined) {
				return outcome(
					settledAction(context),
					domain,
					websiteOutputs(observed),
					websiteDiagnostics(observed),
				);
			}
			const orderId = optionalInteger(context.desired, "orderId");
			if (orderId === undefined) {
				throw purchaseRequired(
					`${productId}: the request names no orderId. A site is created inside a hosting plan the account already bought, and Hostinger's create refuses without one. Set desired.orderId to the plan's order id (GET /api/hosting/v1/orders lists them). This resolver will not buy a plan`,
				);
			}
			const label = `hostinger create website ${domain}`;
			expectRecord(
				await send(context, {
					method: "POST",
					path: WEBSITES_PATH,
					json: {
						domain,
						order_id: orderId,
						...(optionalString(context.desired, "datacenterCode") === undefined
							? undefined
							: {
									datacenter_code: optionalString(
										context.desired,
										"datacenterCode",
									),
								}),
					},
				}),
				label,
			);
			// The create answers with a message, not the record, so the site is
			// read back. A resolver that reported outputs it never observed would
			// be reporting its own request.
			const created = await findWebsite(context);
			if (created === undefined) {
				throw new ResolverError(
					"RESOLVER_PROVIDER_REJECTED",
					`${label}: Hostinger accepted the create but the site is not listed afterwards. Reporting success here would record a resource that may not exist; re-running reconcile is safe and will either find it or create it once`,
					productId,
				);
			}
			return outcome("create", domain, websiteOutputs(created), [
				...websiteDiagnostics(created),
				`the site was created inside order ${orderId}, which the account already owned; nothing here placed an order`,
				...(kind === "static"
					? [
							"Hostinger serves a static site from the same plan as a hosted one; the narrower profile is a claim about what this binding needs, not about a different product",
						]
					: []),
			]);
		},
		async remove(context) {
			const observed = await findWebsite(context);
			if (observed === undefined) return;
			const domain = websiteDomain(context);
			const label = `hostinger delete website ${domain}`;
			const response = await send(context, {
				method: "DELETE",
				path: `${WEBSITES_PATH}/${encodeURIComponent(domain)}`,
			});
			if (isNotFound(response)) return;
			expectRecord(response, label);
		},
	};
}

// ---------------------------------------------------------------------------
// MySQL — a database inside a hosting account
// ---------------------------------------------------------------------------

/**
 * The hosting account a database lives under.
 *
 * Every database endpoint is scoped to one — `/accounts/{username}/databases` —
 * and the account is not derivable from the database name, so it is required
 * rather than guessed. A resolver that picked an account would be choosing
 * which plan gets billed for the storage.
 */
function hostingAccount(context: HostingerResolverContext): string {
	const account =
		optionalString(context.desired, "hostingAccount") ??
		optionalString(context.desired, "username");
	if (account === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${HOSTINGER_MYSQL_PRODUCT_ID}: the request names no hostingAccount — set desired.hostingAccount to the hosting account username the database belongs under (it is the "username" on a website record, and GET /api/hosting/v1/websites reports it). It is not guessed here, because the account decides which plan is billed for the storage`,
			HOSTINGER_MYSQL_PRODUCT_ID,
		);
	}
	return account;
}

function databasesPath(context: HostingerResolverContext): string {
	return `/api/hosting/v1/accounts/${encodeURIComponent(hostingAccount(context))}/databases`;
}

/**
 * Find one database by name.
 *
 * The list endpoint offers `?search=`, which is a substring match rather than
 * an exact filter, so the exact comparison is redone here. Trusting a substring
 * match would let `app_db` adopt `app_db_staging`.
 */
async function findDatabase(
	context: HostingerResolverContext,
): Promise<JsonObject | undefined> {
	const label = `hostinger list databases named ${context.name}`;
	const items = expectList(
		await send(context, {
			method: "GET",
			path: `${databasesPath(context)}?search=${encodeURIComponent(context.name)}`,
		}),
		label,
	);
	const matches = items
		.filter(isJsonObject)
		.filter((item) => optionalString(item, "name") === context.name);
	if (matches.length > 1) {
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			`hostinger databases: ${matches.length} records under the exact name ${JSON.stringify(context.name)} in one account. A database name addresses one database on this API — DELETE takes the name — so choosing one by listing order would make the managed database depend on the order the API answered in`,
		);
	}
	return matches[0];
}

function databaseOutputs(observed: JsonObject): JsonObject {
	const host = optionalString(observed, "host");
	const port = optionalInteger(observed, "port");
	const user = optionalString(observed, "user");
	const domain = optionalString(observed, "domain");
	return {
		ready: host !== undefined,
		databaseName: optionalString(observed, "name") ?? "",
		...(user === undefined ? undefined : { databaseUser: user }),
		...(host === undefined ? undefined : { host }),
		...(port === undefined ? undefined : { port }),
		...(domain === undefined ? undefined : { websiteDomain: domain }),
		// A locator, not a connection string: a DSN would carry the password,
		// and outputs are recorded alongside `desired`.
		...(host === undefined
			? undefined
			: {
					endpoint: `mysql://${host}${port === undefined ? "" : `:${port}`}/${optionalString(observed, "name") ?? ""}`,
				}),
	};
}

/**
 * The database user's password, from the host's custody.
 *
 * Hostinger mints the user and its password in the same call that creates the
 * database, so a create needs material. It does not come from `desired`: core
 * refuses credential-shaped keys in a property bag because `desired` is
 * recorded in the event log, and a key named `passwordRef` in a log is one bad
 * host implementation away from being a password in a log.
 */
async function databasePassword(
	context: HostingerResolverContext,
): Promise<string> {
	const resolve = context.resolveDatabasePassword;
	if (resolve === undefined) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`${HOSTINGER_MYSQL_PRODUCT_ID}: no database password resolver was injected. Construct the resolvers with resolveDatabasePassword(logicalId) — Hostinger mints the database user at create time and demands its password in the same call, the password cannot travel in desired (core refuses credential-shaped keys in a property bag, because desired is recorded in the event log), and this resolver will not invent one, because a password nobody chose is a credential nobody can rotate`,
			HOSTINGER_MYSQL_PRODUCT_ID,
		);
	}
	const material = await resolve(context.request.ref.logicalId);
	if (material.length === 0) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`${HOSTINGER_MYSQL_PRODUCT_ID}: resolveDatabasePassword produced no material for ${JSON.stringify(context.request.ref.logicalId)}. A create sent with an empty password would either be refused by Hostinger or, worse, accepted`,
			HOSTINGER_MYSQL_PRODUCT_ID,
		);
	}
	return material;
}

const MYSQL_SPEC: Omit<HostingerResolverSpec, "productId"> = {
	async read(context) {
		const observed = await findDatabase(context);
		return observed === undefined
			? undefined
			: outcome(
					settledAction(context),
					context.name,
					databaseOutputs(observed),
					[],
				);
	},
	async reconcile(context) {
		const productId = HOSTINGER_MYSQL_PRODUCT_ID;
		refuseInlineSecrets(context, productId);
		const observed = await findDatabase(context);
		if (observed !== undefined) {
			// A MySQL database's shape lives in its schema, which this resolver
			// does not own and will not migrate. Reporting settled is the honest
			// answer; a resolver that "converged" a database would be dropping
			// somebody's tables.
			return outcome(
				settledAction(context),
				context.name,
				databaseOutputs(observed),
				[],
			);
		}
		const user = optionalString(context.desired, "databaseUser");
		if (user === undefined) {
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`${productId}: the request names no databaseUser — set desired.databaseUser. Hostinger creates the database and its user in one call and there is no later endpoint to rename the user, so a name invented here would be permanent`,
				productId,
			);
		}
		const websiteDomainValue = optionalString(context.desired, "websiteDomain");
		if (websiteDomainValue === undefined) {
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`${productId}: the request names no websiteDomain — set desired.websiteDomain to the site the database is assigned to. Hostinger's create requires it, and assigning a database to a site nobody named would attach storage to the wrong plan`,
				productId,
			);
		}
		const label = `hostinger create database ${context.name}`;
		expectRecord(
			await send(context, {
				method: "POST",
				path: databasesPath(context),
				json: {
					name: context.name,
					user,
					// Resolved from the host's custody immediately before the call,
					// and never written back to an output or a diagnostic.
					password: await databasePassword(context),
					website_domain: websiteDomainValue,
				},
			}),
			label,
		);
		const created = await findDatabase(context);
		if (created === undefined) {
			throw new ResolverError(
				"RESOLVER_PROVIDER_REJECTED",
				`${label}: Hostinger accepted the create but the database is not listed afterwards. Reporting success here would record a resource that may not exist; re-running reconcile is safe and will either find it or create it once`,
				productId,
			);
		}
		return outcome("create", context.name, databaseOutputs(created), [
			"the user password came from the injected resolveDatabasePassword and is not in desired, in an output, or in this diagnostic; rotate it through Hostinger's change-password endpoint, not by re-running this resolver",
			"the endpoint output is a locator, not a DSN: a connection string would carry the password, and outputs are recorded alongside desired",
		]);
	},
	async remove(context) {
		const observed = await findDatabase(context);
		if (observed === undefined) return;
		const label = `hostinger delete database ${context.name}`;
		const response = await send(context, {
			method: "DELETE",
			path: `${databasesPath(context)}/${encodeURIComponent(context.name)}`,
		});
		if (isNotFound(response)) return;
		expectRecord(response, label);
	},
};

// ---------------------------------------------------------------------------
// Wrapper and registry
// ---------------------------------------------------------------------------

/** Per-product behaviour; the wrapper owns credentials, naming, and refusals. */
interface HostingerResolverSpec {
	readonly productId: string;
	reconcile(context: HostingerResolverContext): Promise<ResolveOutcome>;
	read(context: HostingerResolverContext): Promise<ResolveOutcome | undefined>;
	remove(context: HostingerResolverContext): Promise<void>;
}

function createResolver(
	spec: HostingerResolverSpec,
	options: HostingerResolverOptions,
): ResourceResolver {
	if (options.resolveCredential === undefined) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			"hostinger resolvers need an injected resolveCredential(ref): the resolver never reads an environment variable or a credential file itself",
		);
	}

	async function contextFor(
		request: ResolveRequest,
		transport: HttpTransport,
	): Promise<HostingerResolverContext> {
		if (request.ref.productId !== spec.productId) {
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`hostinger resolver for ${spec.productId} was handed a request for ${JSON.stringify(request.ref.productId)}; route the request through the registry rather than picking a resolver by hand`,
				spec.productId,
			);
		}
		const token = await resolveToken(request, options.resolveCredential);
		const physicalId = knownPhysicalId(request);
		if (
			physicalId !== undefined &&
			spec.productId !== HOSTINGER_VPS_PRODUCT_ID
		) {
			const desired = parseJsonObject(JSON.stringify(request.desired));
			const address =
				spec.productId === HOSTINGER_WEB_HOSTING_PRODUCT_ID ||
				spec.productId === HOSTINGER_STATIC_SITE_PRODUCT_ID
					? (optionalString(desired, "domain") ??
						resourceName(request, spec.productId))
					: resourceName(request, spec.productId);
			if (address !== physicalId)
				throw new ResolverError(
					"RESOLVER_PRODUCT_UNSUPPORTED",
					"the pinned physical resource identity differs from the requested address",
				);
		}
		return {
			request,
			transport,
			token,
			name: resourceName(request, spec.productId),
			desired: parseJsonObject(JSON.stringify(request.desired)),
			knownPhysicalId: knownPhysicalId(request),
			resolveDatabasePassword:
				spec.productId === HOSTINGER_MYSQL_PRODUCT_ID
					? options.resolveDatabasePassword
					: undefined,
		};
	}

	return {
		providerId: HOSTINGER_PROVIDER_TARGET,
		productId: spec.productId,
		async reconcile(request, transport) {
			const context = await contextFor(request, transport);
			if (context.knownPhysicalId !== undefined) {
				const observed = await spec.read(context);
				assertPinnedIdentity(context, observed);
				if (!observed)
					throw new ResolverError(
						"RESOLVER_PROVIDER_REJECTED",
						"the pinned physical resource is absent; a replacement requires a new authorized resource identity",
					);
			}
			const result = await spec.reconcile(context);
			assertPinnedIdentity(context, result);
			return lifecycleOutcome(
				result,
				result.action === "noop" || result.action === "adopt",
			);
		},
		async read(request, transport) {
			const context = await contextFor(request, transport);
			const result = await spec.read(context);
			assertPinnedIdentity(context, result);
			return result === undefined ? undefined : lifecycleOutcome(result, true);
		},
		async delete(request, transport) {
			const context = await contextFor(request, transport);
			if (context.knownPhysicalId !== undefined) {
				const observed = await spec.read(context);
				assertPinnedIdentity(context, observed);
				if (!observed) return;
			}
			await spec.remove(context);
		},
	};
}

function assertPinnedIdentity(
	context: HostingerResolverContext,
	result: ResolveOutcome | undefined,
): void {
	if (
		result &&
		context.knownPhysicalId !== undefined &&
		result.physicalId !== context.knownPhysicalId
	)
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			"provider observation differs from the pinned physical resource identity",
		);
}

function lifecycleOutcome(
	result: ResolveOutcome,
	observed: boolean,
): ResolveOutcome {
	const ready =
		result.outputs.ready === true && result.diagnostics.length === 0;
	return outcome(
		result.action,
		result.physicalId,
		{ ...result.outputs, ready, operationConfirmed: observed && ready },
		result.diagnostics,
	);
}

/**
 * Every Hostinger resolver, id-sorted so the list is a function of the code
 * rather than of construction order. Every catalogued product has one;
 * {@link HOSTINGER_UNRESOLVED_PRODUCT_IDS} is empty and stays exported so that
 * stops being true loudly rather than quietly.
 */
export function hostingerResolvers(
	options: HostingerResolverOptions,
): readonly ResourceResolver[] {
	const specs: readonly HostingerResolverSpec[] = [
		{ productId: HOSTINGER_DNS_ZONE_PRODUCT_ID, ...DNS_ZONE_SPEC },
		{ productId: HOSTINGER_MYSQL_PRODUCT_ID, ...MYSQL_SPEC },
		{ productId: HOSTINGER_STATIC_SITE_PRODUCT_ID, ...websiteSpec("static") },
		{ productId: HOSTINGER_VPS_PRODUCT_ID, ...VPS_SPEC },
		{ productId: HOSTINGER_WEB_HOSTING_PRODUCT_ID, ...websiteSpec("hosted") },
	];
	return Object.freeze(
		[...specs]
			.sort((left, right) => compareStrings(left.productId, right.productId))
			.map((spec) => createResolver(spec, options)),
	);
}

/** The same resolvers, behind core's product-id lookup. */
export function hostingerResolverRegistry(options: HostingerResolverOptions): {
	get(productId: string): ResourceResolver | undefined;
	list(): readonly ResourceResolver[];
} {
	return createResolverRegistry(hostingerResolvers(options));
}
