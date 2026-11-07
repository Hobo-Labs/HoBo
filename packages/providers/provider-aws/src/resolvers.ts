/**
 * Direct AWS service-API resource resolvers — the default deployment path.
 *
 * Why this module exists: this package used to publish an allocatable AWS
 * catalog and ship no `ResourceResolver`, so a deploy against an AWS Yard
 * failed closed. These resolvers close that gap the same way the Cloudflare
 * and Vercel ones do: a `ResourceResolver` per product talks to the AWS
 * service API over an injected, guarded transport and reconciles one resource
 * at a time. There is no IaC engine, no state file, and no plan/apply round
 * trip between "what the Yard says can be allocated" and "what exists in the
 * account".
 *
 * The property that makes that safe is **convergence**. Every `reconcile()`
 * here is read-or-create: it asks AWS whether the deterministically-named
 * resource already exists — by a direct describe where the API offers one, by
 * a bounded paged list where it does not — *before* it creates anything, then
 * applies only the mutable deltas. Running it twice produces the same
 * `physicalId`, exactly one resource, and exactly one create call, which is
 * what makes a crashed half-apply safe to re-run instead of something an
 * operator reconciles by hand. `delete()` treats "already gone" as success for
 * the same reason. `"replace"` is never emitted: replacing a bucket or a table
 * destroys data, so drift on an immutable field is reported as a diagnostic
 * and left for a human.
 *
 * A product with no convergent path ships **no resolver** rather than a
 * plausible one — see {@link AWS_UNRESOLVED_PRODUCT_IDS}, which names each one
 * and why. A resolver that duplicates a resource on every retry is worse than
 * an absent one.
 *
 * AWS does not take a bearer token. Every request is signed with SigV4 by
 * `@hobo/core/aws-sigv4`, whose signer is pinned against the official
 * `aws-sig-v4-test-suite` vectors in `@hobo/core`'s tests — the only proof of
 * a signer available to a repo that cannot reach the live API. Credentials are
 * *locators*: a resolver is constructed with an injected
 * `resolveCredential(ref)`, `ResolveRequest.credentialRef` must match core's
 * `scheme://path` grammar, and material appears in exactly one place — the
 * `authorization` request header — never in an outcome, a diagnostic, or a
 * message. Provider error text is redacted before it reaches any of those,
 * because AWS echoes request context (including the access key id) in error
 * bodies.
 *
 * Three wire shapes, handled honestly rather than pretended into one:
 *   - **REST-XML** (S3): the operation is the HTTP method plus a subresource
 *     query; responses are XML.
 *   - **REST-JSON with a target header** (DynamoDB, Secrets Manager, SSM):
 *     `POST /` with `x-amz-target` naming the operation and a JSON body.
 *   - **Query protocol** (SQS, SNS): `POST /` with an `Action=…` form body and
 *     an XML response.
 *
 * Determinism: no clock and no randomness in request formation. SigV4 does
 * genuinely need a timestamp, so it is injected (`AwsResolverOptions.nowMs`)
 * and never read from `Date.now()` here, which is what makes a signed request
 * byte-stable in a test.
 *
 * HONEST SCOPE (also in the README):
 *   - These resolvers are exercised against an *injected fake* transport
 *     modelling an AWS account. Nothing in this package proves a live deploy:
 *     that additionally needs real credentials, real network egress, and a
 *     real AWS account, none of which a unit test supplies.
 *   - The `productId` strings are read off the `./slots.js` factories, so the
 *     resolver registry and the Yard catalog cannot drift apart. Whether a
 *     matching Resource Definition is registered in the catalog is still
 *     checked at resolution time (`YARD_BINDING_PRODUCT_UNKNOWN`), not here.
 *   - Coverage is a slice of each service's API — enough to allocate, observe,
 *     converge, and remove the resource — and explicitly not the whole
 *     surface. The exact endpoints are named in the README.
 */

import {
	createResolverRegistry,
	type HttpTransport,
	parseResolveRequest,
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
import { type AwsCredentials, signAwsRequest } from "@hobo/core/aws-sigv4";

import {
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonObject,
} from "./json.js";
import { AWS_PROVIDER_TARGET } from "./options.js";
import {
	dynamodb,
	lambda,
	s3,
	secretsManager,
	sns,
	sqs,
	sqsFifo,
	ssmParameterStore,
} from "./slots.js";
import {
	AWS_MAX_RESPONSE_BYTES,
	AWS_MAX_TIMEOUT_MS,
	type AwsResolverService,
	awsServiceUrl,
	guardedAwsTransport,
	parseAwsRegion,
} from "./transport.js";

// ---------------------------------------------------------------------------
// Product ids
// ---------------------------------------------------------------------------

/**
 * Product ids are read off the slot factories rather than retyped, so the
 * registry cannot silently stop covering a product the Yard still offers.
 */
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

export const AWS_S3_PRODUCT_ID = productIdOf(s3(), "s3");
export const AWS_DYNAMODB_PRODUCT_ID = productIdOf(dynamodb(), "dynamodb");
export const AWS_LAMBDA_PRODUCT_ID = productIdOf(lambda(), "lambda");
export const AWS_SQS_PRODUCT_ID = productIdOf(sqs(), "sqs");
export const AWS_SQS_FIFO_PRODUCT_ID = productIdOf(sqsFifo(), "sqsFifo");
export const AWS_SNS_PRODUCT_ID = productIdOf(sns(), "sns");
export const AWS_SECRETS_MANAGER_PRODUCT_ID = productIdOf(
	secretsManager(),
	"secretsManager",
);
export const AWS_SSM_PARAMETER_PRODUCT_ID = productIdOf(
	ssmParameterStore(),
	"ssmParameterStore",
);

/** Every product this module resolves, id-sorted for a deterministic registry. */
export const AWS_RESOLVED_PRODUCT_IDS = Object.freeze(
	[
		AWS_DYNAMODB_PRODUCT_ID,
		AWS_LAMBDA_PRODUCT_ID,
		AWS_S3_PRODUCT_ID,
		AWS_SECRETS_MANAGER_PRODUCT_ID,
		AWS_SNS_PRODUCT_ID,
		AWS_SQS_FIFO_PRODUCT_ID,
		AWS_SQS_PRODUCT_ID,
		AWS_SSM_PARAMETER_PRODUCT_ID,
	].sort(compareStrings),
);

/**
 * Product ids this package catalogs but deliberately cannot resolve
 * convergently. Each entry is a decision, not a backlog item:
 *
 * `aws.rds-postgres/v1`, `aws.rds-mysql/v1`,
 * `aws.aurora-serverless-postgres/v1`: `CreateDBInstance`/`CreateDBCluster`
 * take a `MasterUserPassword`. That value would have to travel in
 * `ResolveRequest.desired` — the record that reaches the event log, the plan
 * digest, and every diagnostic printed from them — which is exactly what the
 * credential law forbids. The managed-master-password alternative needs a KMS
 * key and a Secrets Manager attachment this package cannot derive, and both
 * paths additionally need a DB subnet group and a security group that a Yard
 * binding does not name. Refused rather than half-built.
 * `aws.elasticache-redis/v1`: `CreateCacheCluster` places the cluster in a
 * cache subnet group and a security group that no binding names; omitting them
 * silently lands the cluster in the default VPC, which is a network decision
 * this resolver is not entitled to take.
 * `aws.ecs-service/v1`, `aws.ecs-task/v1`, `aws.eks-deployment/v1`: every one
 * needs a cluster, a task-execution role, and a network configuration that
 * exist outside the binding; and an EKS Deployment is a Kubernetes API object,
 * not an AWS API one, so it is not reachable over this transport at all.
 * `aws.app-runner/v1`, `aws.amplify-hosting/v1`: creation is
 * source-connection-scoped (an ECR image or a connected repository) and
 * returns a new service ARN per call, with no documented list-by-name filter
 * to converge against.
 * `aws.api-gateway/v1`: `CreateRestApi`/`CreateApi` assign a fresh random API
 * id on every call and there is no name-unique constraint, so a retry after a
 * lost response creates a second API.
 * `aws.cloudfront-site/v1`: `CreateDistribution` returns a new distribution id
 * per call; the only name-ish handle is a caller reference AWS uses for
 * *deduplication windows*, not for identity, so it cannot carry convergence.
 */
export const AWS_UNRESOLVED_PRODUCT_IDS = Object.freeze(
	[
		"aws.amplify-hosting/v1",
		"aws.api-gateway/v1",
		"aws.app-runner/v1",
		"aws.aurora-serverless-postgres/v1",
		"aws.cloudfront-site/v1",
		"aws.ecs-service/v1",
		"aws.ecs-task/v1",
		"aws.eks-deployment/v1",
		"aws.elasticache-redis/v1",
		"aws.rds-mysql/v1",
		"aws.rds-postgres/v1",
	].sort(compareStrings),
);

// ---------------------------------------------------------------------------
// Options, credentials, redaction
// ---------------------------------------------------------------------------

/** What a host must supply to build the resolvers. */
export interface AwsResolverOptions {
	/** The region every endpoint is scoped to. Parsed, never interpolated raw. */
	readonly region: string;
	/**
	 * Resolves a credential *locator* to material. Injected so the resolver
	 * never holds a secret and never decides where secrets live. Returning the
	 * structured credentials rather than a string means this package never
	 * parses material and never has a reason to hold it as text.
	 */
	readonly resolveCredential: (ref: string) => Promise<AwsCredentials>;
	/**
	 * The signing clock. SigV4 genuinely needs a timestamp; injecting it is
	 * what keeps a signed request byte-stable in a test. A function is the
	 * honest shape for a long deploy — a frozen number would eventually fall
	 * outside AWS's signature validity window — but a number is accepted for
	 * the single-shot case.
	 */
	readonly nowMs: number | (() => number);
}

/**
 * A credential locator, using the same grammar core's `parseResolveRequest`
 * enforces (`scheme://path`, no userinfo). Restated here rather than imported
 * because a resolver must refuse a bad ref even when a caller skipped the
 * parse boundary — and a second grammar would be a second answer.
 */
const CREDENTIAL_REF_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^\s@]+$/u;

/**
 * What an AWS access key id looks like when someone pastes the value into the
 * `credentialRef` field by mistake: `AKIA…`/`ASIA…` and friends, or any long
 * unbroken token-shaped run.
 */
const RAW_CREDENTIAL_PATTERN = /^(?:[A-Z0-9]{16,}|[A-Za-z0-9/+=_-]{32,})$/u;

/** Anything long and token-shaped is scrubbed out of provider error text. */
const TOKEN_PATTERN = /[A-Za-z0-9/+=_-]{20,}/gu;

/**
 * Redact provider text before it reaches a message, a diagnostic, or a log.
 * The resolved material is removed by exact match first — that is the part
 * that must never survive — and anything else token-shaped after it, because
 * AWS error bodies echo request context and have carried an access key id.
 */
export function redactAwsText(
	text: string,
	credentials: AwsCredentials | undefined,
	limit = 400,
): string {
	let scrubbed = text;
	for (const material of [
		credentials?.secretAccessKey,
		credentials?.sessionToken,
		credentials?.accessKeyId,
	]) {
		if (material !== undefined && material.length >= 4) {
			scrubbed = scrubbed.split(material).join("[redacted]");
		}
	}
	scrubbed = scrubbed.replace(TOKEN_PATTERN, "[redacted]");
	return scrubbed.length > limit ? `${scrubbed.slice(0, limit)}…` : scrubbed;
}

/**
 * The credential parse boundary.
 *
 * A blank ref is `RESOLVER_CREDENTIAL_MISSING`, a value-shaped one is
 * `RESOLVER_CREDENTIAL_NOT_A_REF` — a raw key in a request record has already
 * leaked by the time it is used — and a resolver that hands back nothing
 * usable is missing, never "carry on unauthenticated".
 */
async function resolveAwsCredentials(
	request: ResolveRequest,
	resolve: (ref: string) => Promise<AwsCredentials>,
): Promise<AwsCredentials> {
	const ref = request.credentialRef;
	if (ref.trim().length === 0) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			'aws resolver: credentialRef is empty. Supply a locator such as "env://AWS_DEPLOY_CREDENTIALS" or "secret://camp/aws-deploy" and register it with the host credential resolver; the resolver never accepts inline credential material',
		);
	}
	const trimmed = ref.trim();
	if (RAW_CREDENTIAL_PATTERN.test(trimmed)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			"aws resolver: credentialRef looks like credential material rather than a locator. Store the access key with the host secret custody and pass its reference (scheme://path); a raw key in a ResolveRequest is a key in the event log",
		);
	}
	if (!CREDENTIAL_REF_PATTERN.test(trimmed)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			`aws resolver: credentialRef ${JSON.stringify(redactAwsText(trimmed, undefined, 60))} is not a locator. Expected "<scheme>://<path>", for example "secret://camp/aws-deploy"`,
		);
	}
	let material: AwsCredentials;
	try {
		material = await resolve(trimmed);
	} catch (cause) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`aws resolver: the host could not resolve credentialRef ${JSON.stringify(trimmed)}: ${redactAwsText(
				cause instanceof Error ? cause.message : String(cause),
				undefined,
				160,
			)}. Register the reference with the credential resolver before deploying`,
		);
	}
	// Check the shape before reading fields. `resolve` is an injected host
	// callback, so `AwsCredentials` is what it *promises* to return, not what it
	// did -- and reading `.accessKeyId` off `undefined` or a string throws a
	// TypeError, which is precisely the untyped failure this boundary exists to
	// turn into a refusal an operator can act on.
	// Inspect own data properties rather than invoking host-provided getters.
	// Primitives are boxed to empty or indexed values and fail the field checks.
	const fields = Object.getOwnPropertyDescriptors(Object(material));
	const accessKeyId = fields.accessKeyId?.value;
	const secretAccessKey = fields.secretAccessKey?.value;
	const sessionToken = fields.sessionToken?.value;
	if (
		Array.isArray(material) ||
		!isJsonString(accessKeyId) ||
		!isJsonString(secretAccessKey) ||
		accessKeyId.trim().length === 0 ||
		secretAccessKey.trim().length === 0 ||
		(sessionToken !== undefined &&
			(!isJsonString(sessionToken) || sessionToken.trim().length === 0))
	) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`aws resolver: credentialRef ${JSON.stringify(trimmed)} did not resolve to an access key id and secret access key. A missing credential is refused rather than retried unsigned, which would look like a permissions error at the provider`,
		);
	}
	const parsed: AwsCredentials = { accessKeyId, secretAccessKey };
	if (sessionToken !== undefined) Object.assign(parsed, { sessionToken });
	return parsed;
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

function optionalBoolean(record: JsonObject, key: string): boolean | undefined {
	const value = record[key];
	return isJsonBoolean(value) ? value : undefined;
}

function optionalInteger(record: JsonObject, key: string): number | undefined {
	const value = record[key];
	return isJsonNumber(value) && Number.isSafeInteger(value) ? value : undefined;
}

/** The JSON type of a value, as a refusal names it. */
function jsonTypeName(value: JsonValue): string {
	if (isJsonArray(value)) return "an array";
	if (isJsonObject(value)) return "an object";
	if (isJsonString(value)) return "a string";
	if (isJsonNumber(value)) return "a number";
	if (isJsonBoolean(value)) return "a boolean";
	return "null";
}

/**
 * A member of a provider's JSON answer that must be a string, or an object.
 * Absent and `null` are `undefined`, as Smithy's JSON protocols read a null
 * member. Any other type means the answer is not the documented one: that is a
 * provider fault, refused as RESOLVER_OUTPUT_UNPARSEABLE like every other
 * answer this file cannot read, never read as absent. A blank string reads as
 * absent, as `optionalString` reads one.
 */
function answerString(
	record: JsonObject,
	key: string,
	label: string,
): string | undefined {
	const value = record[key];
	if (value === undefined || value === null) return undefined;
	if (isJsonString(value)) return value.trim().length > 0 ? value : undefined;
	throw unparseable(
		label,
		`AWS answered "${key}" with ${jsonTypeName(value)}, not a string, so the answer is not the documented one; it is refused rather than read as absent`,
	);
}

/** As {@link answerString}, for a member that must be an object. */
function answerRecord(
	record: JsonObject,
	key: string,
	label: string,
): JsonObject | undefined {
	const value = record[key];
	if (value === undefined || value === null) return undefined;
	if (isJsonObject(value)) return value;
	throw unparseable(
		label,
		`AWS answered "${key}" with ${jsonTypeName(value)}, not an object, so the answer is not the documented one; it is refused rather than read as absent`,
	);
}

/**
 * RFC 3986 percent-encoding, used for both path segments and the query-protocol
 * form bodies. `encodeURIComponent` leaves `!'()*` alone and AWS does not, and
 * a form parameter that encodes differently than it was signed is a signature
 * mismatch rather than a friendly error.
 */
function encodeComponent(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/gu,
		(character) =>
			`%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
	);
}

function formBody(parameters: readonly (readonly [string, string])[]): string {
	return parameters
		.map(
			([name, value]) => `${encodeComponent(name)}=${encodeComponent(value)}`,
		)
		.join("&");
}

// ---------------------------------------------------------------------------
// XML reading
// ---------------------------------------------------------------------------

/**
 * Pull the text of an XML element by name.
 *
 * This is a **bounded forward scan built on `indexOf`** — no regex, so no
 * catastrophic backtracking on a hostile body, and no recursion, so no stack
 * growth with nesting depth. It reads only the elements these resolvers
 * actually need (`QueueUrl`, `TopicArn`, `Code`, `Message`, and friends), and
 * it is deliberately *not* a general XML parser: it does not understand
 * namespaces, CDATA, comments, or attributes, and a body that needs any of
 * those is a body this module has no business interpreting. Response size is
 * already bounded by the transport guard.
 */
function xmlBlocks(xml: string, tag: string): readonly string[] {
	const open = `<${tag}`;
	const close = `</${tag}>`;
	const found: string[] = [];
	let cursor = 0;
	while (cursor < xml.length) {
		const start = xml.indexOf(open, cursor);
		if (start < 0) break;
		const boundary = xml.charAt(start + open.length);
		// `<Code` must not match `<CodeSigningConfig`: the next character has to
		// end the name.
		if (
			boundary !== ">" &&
			boundary !== " " &&
			boundary !== "\t" &&
			boundary !== "\n" &&
			boundary !== "\r" &&
			boundary !== "/"
		) {
			cursor = start + open.length;
			continue;
		}
		const openEnd = xml.indexOf(">", start);
		if (openEnd < 0) break;
		if (xml.charAt(openEnd - 1) === "/") {
			// Self-closing element: present, empty.
			found.push("");
			cursor = openEnd + 1;
			continue;
		}
		const closeStart = xml.indexOf(close, openEnd + 1);
		if (closeStart < 0) break;
		found.push(xml.slice(openEnd + 1, closeStart));
		cursor = closeStart + close.length;
	}
	return found;
}

/** The five predefined XML entities; nothing else is decoded. */
function decodeXmlText(value: string): string {
	return value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
}

function xmlText(xml: string, tag: string): string | undefined {
	const first = xmlBlocks(xml, tag)[0];
	if (first === undefined) return undefined;
	const decoded = decodeXmlText(first).trim();
	return decoded.length > 0 ? decoded : undefined;
}

function xmlTexts(xml: string, tag: string): readonly string[] {
	return xmlBlocks(xml, tag).map((block) => decodeXmlText(block).trim());
}

// ---------------------------------------------------------------------------
// The call boundary
// ---------------------------------------------------------------------------

interface AwsCall {
	readonly service: AwsResolverService;
	readonly method: TransportMethod;
	/** Already-encoded path, optionally with a query string. */
	readonly path: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string;
}

/** Everything a resolver body needs, with the credential already resolved. */
interface AwsResolverContext {
	readonly request: ResolveRequest;
	readonly transport: HttpTransport;
	readonly credentials: AwsCredentials;
	readonly region: string;
	readonly nowMs: () => number;
	/** The deterministic resource name: `desired.name`, else the logical id. */
	readonly name: string;
	readonly desired: JsonObject;
	/** True when the caller already knows the physical id (adopt vs noop). */
	readonly knownPhysicalId: string | undefined;
	/**
	 * The product's directives the declaration switches on. Each declared
	 * directive was parsed as a boolean at the boundary ({@link parseSettings}),
	 * so a resolver reads this set and never `desired` for a directive.
	 */
	readonly directivesOn: ReadonlySet<string>;
	redact(text: string, limit?: number): string;
}

/**
 * Sign one request and hand it to the guarded transport.
 *
 * The signed headers are folded to lower case so credential material lands in
 * exactly one place a reader has to check — `authorization` — and never in a
 * second casing of the same header.
 */
async function send(
	context: AwsResolverContext,
	call: AwsCall,
): Promise<TransportResponse> {
	const url = awsServiceUrl(call.service, context.region, call.path);
	const signed = signAwsRequest({
		method: call.method,
		url,
		headers: call.headers === undefined ? {} : { ...call.headers },
		...(call.body === undefined ? undefined : { body: call.body }),
		region: context.region,
		service: call.service,
		credentials: context.credentials,
		now: new Date(context.nowMs()),
	});
	const headers = {};
	for (const [name, value] of Object.entries(signed.headers)) {
		Object.assign(headers, { [name.toLowerCase()]: value });
	}
	return context.transport({
		method: call.method,
		url,
		headers,
		...(call.body === undefined ? undefined : { body: call.body }),
		timeoutMs: AWS_MAX_TIMEOUT_MS,
		maxResponseBytes: AWS_MAX_RESPONSE_BYTES,
	});
}

function isSuccess(response: TransportResponse): boolean {
	return response.status >= 200 && response.status < 300;
}

function tryJson(body: string): JsonValue | undefined {
	try {
		// SAFETY: JSON.parse yields a JSON value at this document boundary.
		return JSON.parse(body) as JsonValue;
	} catch {
		return undefined;
	}
}

/**
 * AWS JSON errors name their type in `__type` as
 * `com.amazonaws.dynamodb.v20120810#ResourceNotFoundException`. Only the last
 * segment identifies the error; the prefix is a package path that changes
 * between services and API versions.
 */
function jsonErrorCode(body: string): string | undefined {
	const parsed = tryJson(body);
	if (!isJsonObject(parsed)) return undefined;
	const declared =
		optionalString(parsed, "__type") ?? optionalString(parsed, "code");
	if (declared === undefined) return undefined;
	const hash = declared.lastIndexOf("#");
	const withoutPackage = hash < 0 ? declared : declared.slice(hash + 1);
	const colon = withoutPackage.indexOf(":");
	return colon < 0 ? withoutPackage : withoutPackage.slice(0, colon);
}

function jsonErrorMessage(body: string): string | undefined {
	const parsed = tryJson(body);
	if (!isJsonObject(parsed)) return undefined;
	return optionalString(parsed, "message") ?? optionalString(parsed, "Message");
}

/** The JSON body of a successful call, or a typed refusal. */
function jsonResult(
	context: AwsResolverContext,
	response: TransportResponse,
	label: string,
): JsonObject {
	if (!isSuccess(response)) rejectJson(context, response, label);
	const parsed = tryJson(response.body);
	if (!isJsonObject(parsed)) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: AWS returned a status ${response.status} body that is not a JSON object, so the outcome of the call is unknown and it is refused rather than assumed; retry, and if it repeats the API contract has changed`,
		);
	}
	return parsed;
}

function rejectJson(
	context: AwsResolverContext,
	response: TransportResponse,
	label: string,
): never {
	const code = jsonErrorCode(response.body);
	const detail = jsonErrorMessage(response.body) ?? response.body;
	throw new ResolverError(
		"RESOLVER_PROVIDER_REJECTED",
		`${label}: AWS refused the call with status ${response.status}${
			code === undefined ? "" : ` (${code})`
		}: ${context.redact(detail, 240)}`,
	);
}

/** The XML body of a successful call, or a typed refusal. */
function xmlResult(
	context: AwsResolverContext,
	response: TransportResponse,
	label: string,
): string {
	if (!isSuccess(response)) rejectXml(context, response, label);
	return response.body;
}

function xmlErrorCode(body: string): string | undefined {
	return xmlText(body, "Code");
}

function rejectXml(
	context: AwsResolverContext,
	response: TransportResponse,
	label: string,
): never {
	const code = xmlErrorCode(response.body);
	const detail = xmlText(response.body, "Message") ?? response.body;
	throw new ResolverError(
		"RESOLVER_PROVIDER_REJECTED",
		`${label}: AWS refused the call with status ${response.status}${
			code === undefined ? "" : ` (${code})`
		}: ${context.redact(detail, 240)}`,
	);
}

function unparseable(label: string, why: string): ResolverError {
	return new ResolverError("RESOLVER_OUTPUT_UNPARSEABLE", `${label}: ${why}`);
}

// ---------------------------------------------------------------------------
// Outcome helpers
// ---------------------------------------------------------------------------

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
 * Existing resource, no delta: `noop` when the caller already named it,
 * `adopt` when the resolver found something the request did not know about.
 * The distinction is the audit record — adoption of an unmanaged resource is a
 * fact an operator should be able to see, not something folded into "nothing
 * happened".
 */
function settledAction(context: AwsResolverContext): ResolverAction {
	return context.knownPhysicalId === undefined ? "adopt" : "noop";
}

function resourceName(request: ResolveRequest, productId: string): string {
	const desiredName = optionalString(
		parseJsonObject(JSON.stringify(request.desired)),
		"name",
	);
	if (desiredName !== undefined) return desiredName;
	const { logicalId } = request.ref;
	if (logicalId.trim().length > 0) {
		return logicalId;
	}
	throw new ResolverError(
		"RESOLVER_PRODUCT_UNSUPPORTED",
		`${productId}: the request names no resource — set desired.name or ref.logicalId. The name is what makes reconcile convergent, so it is never generated here`,
		productId,
	);
}

function knownPhysicalId(request: ResolveRequest): string | undefined {
	const value = request.ref.physicalId;
	return value !== undefined && value.trim().length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// S3 buckets — REST-XML on s3.{region}.amazonaws.com
// ---------------------------------------------------------------------------

/**
 * Path-style addressing (`/{bucket}`) rather than virtual-hosted
 * (`{bucket}.s3.…`). Both are valid for the bucket-level operations here, and
 * path-style keeps the transport allowlist to one reviewable host per region
 * instead of one host per bucket name a caller happens to pass.
 */
const S3_BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;

const S3_XMLNS = "http://s3.amazonaws.com/doc/2006-03-01/";

function s3Bucket(context: AwsResolverContext): string {
	if (!S3_BUCKET_PATTERN.test(context.name)) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${AWS_S3_PRODUCT_ID}: bucket name ${JSON.stringify(context.name)} does not match S3's DNS-safe grammar ${S3_BUCKET_PATTERN.source}; S3 would refuse it, so it is refused here where the message can say why`,
			AWS_S3_PRODUCT_ID,
		);
	}
	return context.name;
}

function s3Path(context: AwsResolverContext, subresource = ""): string {
	return `/${encodeComponent(s3Bucket(context))}${subresource}`;
}

interface S3Observed {
	readonly location: string;
	readonly versioning: string | undefined;
	readonly publicAccessBlocked: boolean;
}

/**
 * GetBucketLocation is the existence probe: it is a cheap GET that answers 404
 * `NoSuchBucket` when the bucket is not there and 200 with the constraint when
 * it is. HEAD would be the obvious call and is not available — the transport
 * method vocabulary is GET/POST/PUT/PATCH/DELETE.
 */
async function readS3(
	context: AwsResolverContext,
): Promise<S3Observed | undefined> {
	const label = `s3 get bucket location ${context.name}`;
	const located = await send(context, {
		service: "s3",
		method: "GET",
		path: s3Path(context, "?location"),
	});
	if (located.status === 404) return undefined;
	const locationBody = xmlResult(context, located, label);
	// An empty LocationConstraint is us-east-1; S3 has always reported it that
	// way and a caller comparing regions needs the real name, not "".
	const location = xmlText(locationBody, "LocationConstraint") ?? "us-east-1";

	const versioningResponse = await send(context, {
		service: "s3",
		method: "GET",
		path: s3Path(context, "?versioning"),
	});
	const versioningBody = xmlResult(
		context,
		versioningResponse,
		`s3 get bucket versioning ${context.name}`,
	);
	const versioning = xmlText(versioningBody, "Status");

	const blockResponse = await send(context, {
		service: "s3",
		method: "GET",
		path: s3Path(context, "?publicAccessBlock"),
	});
	// 404 NoSuchPublicAccessBlockConfiguration is the documented "not
	// configured" answer, not a failure.
	const publicAccessBlocked =
		blockResponse.status === 404
			? false
			: xmlText(
					xmlResult(
						context,
						blockResponse,
						`s3 get public access block ${context.name}`,
					),
					"BlockPublicAcls",
				) === "true";

	return {
		location,
		...(versioning === undefined ? { versioning: undefined } : { versioning }),
		publicAccessBlocked,
	};
}

function s3Outputs(name: string, observed: S3Observed): JsonObject {
	return {
		bucketName: name,
		region: observed.location,
		publicAccessBlocked: observed.publicAccessBlocked,
		...(observed.versioning === undefined
			? undefined
			: { versioning: observed.versioning }),
	};
}

function s3Diagnostics(
	context: AwsResolverContext,
	observed: S3Observed,
): readonly string[] {
	const diagnostics: string[] = [];
	if (optionalString(context.desired, "storageClass") !== undefined) {
		diagnostics.push(
			"storageClass is declared but not applied: S3 has no bucket-level storage class — it is a per-object property or a lifecycle rule, neither of which this resolver manages",
		);
	}
	if (observed.location !== context.region) {
		diagnostics.push(
			`bucket is in ${observed.location} but this resolver is scoped to ${context.region}; a bucket's region is immutable and this resolver never replaces a bucket, so the drift is reported rather than corrected`,
		);
	}
	return diagnostics;
}

const S3_SPEC: Omit<AwsResolverSpec, "productId"> = {
	settings: {
		versioning: "boolean",
		publicAccessBlocked: "boolean",
		storageClass: "string",
	},
	async read(context) {
		const observed = await readS3(context);
		if (observed === undefined) return undefined;
		return outcome(
			settledAction(context),
			s3Bucket(context),
			s3Outputs(context.name, observed),
			s3Diagnostics(context, observed),
		);
	},
	async reconcile(context) {
		const bucket = s3Bucket(context);
		let observed = await readS3(context);
		let action: ResolverAction = settledAction(context);

		if (observed === undefined) {
			// us-east-1 is the only region CreateBucket refuses a
			// LocationConstraint for; everywhere else it is required.
			const body =
				context.region === "us-east-1"
					? undefined
					: `<CreateBucketConfiguration xmlns="${S3_XMLNS}"><LocationConstraint>${context.region}</LocationConstraint></CreateBucketConfiguration>`;
			const created = await send(context, {
				service: "s3",
				method: "PUT",
				path: s3Path(context),
				...(body === undefined
					? undefined
					: { headers: { "content-type": "text/xml" }, body }),
			});
			xmlResult(context, created, `s3 create bucket ${context.name}`);
			action = "create";
			observed = {
				location: context.region,
				versioning: undefined,
				publicAccessBlocked: false,
			};
		}

		const wantVersioning = optionalBoolean(context.desired, "versioning");
		if (wantVersioning !== undefined) {
			const wanted = wantVersioning ? "Enabled" : "Suspended";
			const current = observed.versioning ?? "Suspended";
			if (current !== wanted) {
				const response = await send(context, {
					service: "s3",
					method: "PUT",
					path: s3Path(context, "?versioning"),
					headers: { "content-type": "text/xml" },
					body: `<VersioningConfiguration xmlns="${S3_XMLNS}"><Status>${wanted}</Status></VersioningConfiguration>`,
				});
				xmlResult(
					context,
					response,
					`s3 put bucket versioning ${context.name}`,
				);
				observed = { ...observed, versioning: wanted };
				if (action !== "create") action = "update";
			}
		}

		const wantBlocked = optionalBoolean(context.desired, "publicAccessBlocked");
		if (wantBlocked === true && !observed.publicAccessBlocked) {
			const response = await send(context, {
				service: "s3",
				method: "PUT",
				path: s3Path(context, "?publicAccessBlock"),
				headers: { "content-type": "text/xml" },
				body: `<PublicAccessBlockConfiguration xmlns="${S3_XMLNS}"><BlockPublicAcls>true</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>true</BlockPublicPolicy><RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>`,
			});
			xmlResult(
				context,
				response,
				`s3 put public access block ${context.name}`,
			);
			observed = { ...observed, publicAccessBlocked: true };
			if (action !== "create") action = "update";
		}

		return outcome(
			action,
			bucket,
			s3Outputs(context.name, observed),
			s3Diagnostics(context, observed),
		);
	},
	async remove(context) {
		const response = await send(context, {
			service: "s3",
			method: "DELETE",
			path: s3Path(context),
		});
		if (response.status === 404) return;
		xmlResult(context, response, `s3 delete bucket ${context.name}`);
	},
};

// ---------------------------------------------------------------------------
// DynamoDB tables — REST-JSON with an x-amz-target header
// ---------------------------------------------------------------------------

const DYNAMODB_TARGET_PREFIX = "DynamoDB_20120810";
const DYNAMODB_CONTENT_TYPE = "application/x-amz-json-1.0";
const DYNAMODB_KEY_TYPES = Object.freeze(["S", "N", "B"] as const);

async function dynamoCall(
	context: AwsResolverContext,
	operation: string,
	payload: JsonObject,
): Promise<TransportResponse> {
	return send(context, {
		service: "dynamodb",
		method: "POST",
		path: "/",
		headers: {
			"content-type": DYNAMODB_CONTENT_TYPE,
			"x-amz-target": `${DYNAMODB_TARGET_PREFIX}.${operation}`,
		},
		body: JSON.stringify(payload),
	});
}

function dynamoKeyType(
	context: AwsResolverContext,
	key: string,
): "S" | "N" | "B" {
	const declared = optionalString(context.desired, key);
	if (declared === undefined) return "S";
	switch (declared) {
		case "S":
		case "N":
		case "B":
			return declared;
		default:
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`${AWS_DYNAMODB_PRODUCT_ID}: desired.${key} must be one of ${DYNAMODB_KEY_TYPES.join(" | ")}, received ${JSON.stringify(declared)}`,
				AWS_DYNAMODB_PRODUCT_ID,
			);
	}
}

interface DynamoBilling {
	readonly mode: "PAY_PER_REQUEST" | "PROVISIONED";
	readonly readCapacity: number | undefined;
	readonly writeCapacity: number | undefined;
	readonly defaulted: boolean;
}

function dynamoBilling(context: AwsResolverContext): DynamoBilling {
	const declared = optionalString(context.desired, "billingMode");
	if (declared === undefined) {
		return {
			mode: "PAY_PER_REQUEST",
			readCapacity: undefined,
			writeCapacity: undefined,
			defaulted: true,
		};
	}
	if (declared === "on-demand") {
		return {
			mode: "PAY_PER_REQUEST",
			readCapacity: undefined,
			writeCapacity: undefined,
			defaulted: false,
		};
	}
	if (declared !== "provisioned") {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${AWS_DYNAMODB_PRODUCT_ID}: desired.billingMode must be "on-demand" or "provisioned", received ${JSON.stringify(declared)}`,
			AWS_DYNAMODB_PRODUCT_ID,
		);
	}
	const readCapacity = optionalInteger(context.desired, "readCapacity");
	const writeCapacity = optionalInteger(context.desired, "writeCapacity");
	if (
		readCapacity === undefined ||
		writeCapacity === undefined ||
		readCapacity <= 0 ||
		writeCapacity <= 0
	) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${AWS_DYNAMODB_PRODUCT_ID}: provisioned billing needs positive desired.readCapacity and desired.writeCapacity. Inventing a capacity would bill the account for a number nobody chose, so it is refused`,
			AWS_DYNAMODB_PRODUCT_ID,
		);
	}
	return { mode: "PROVISIONED", readCapacity, writeCapacity, defaulted: false };
}

async function readDynamoTable(
	context: AwsResolverContext,
): Promise<JsonObject | undefined> {
	const label = `dynamodb describe table ${context.name}`;
	const response = await dynamoCall(context, "DescribeTable", {
		TableName: context.name,
	});
	if (
		!isSuccess(response) &&
		jsonErrorCode(response.body) === "ResourceNotFoundException"
	) {
		return undefined;
	}
	const body = jsonResult(context, response, label);
	const table = answerRecord(body, "Table", label);
	if (table === undefined) {
		throw unparseable(
			label,
			'AWS returned a successful DescribeTable with no "Table" object, so the table cannot be identified',
		);
	}
	return table;
}

function dynamoTableArn(table: JsonObject, label: string): string {
	const arn = answerString(table, "TableArn", label);
	if (arn === undefined) {
		throw unparseable(
			label,
			'AWS returned a table description without a "TableArn", so the table cannot be addressed',
		);
	}
	return arn;
}

function dynamoObservedMode(
	table: JsonObject,
	label: string,
): string | undefined {
	const summary = answerRecord(table, "BillingModeSummary", label);
	return summary === undefined
		? undefined
		: answerString(summary, "BillingMode", label);
}

function dynamoOutputs(table: JsonObject, name: string): JsonObject {
	const label = `dynamodb table ${name}`;
	const status = answerString(table, "TableStatus", label);
	const mode = dynamoObservedMode(table, label);
	return {
		tableName: name,
		tableArn: answerString(table, "TableArn", label) ?? "",
		...(status === undefined ? undefined : { tableStatus: status }),
		...(mode === undefined ? undefined : { billingMode: mode }),
	};
}

function dynamoKeyDiagnostics(
	context: AwsResolverContext,
	table: JsonObject,
): readonly string[] {
	const label = `dynamodb describe table ${context.name}`;
	const wanted = optionalString(context.desired, "partitionKey") ?? "pk";
	const schema = table.KeySchema;
	if (schema === undefined || schema === null) return [];
	if (!isJsonArray(schema)) {
		throw unparseable(
			label,
			`AWS answered "KeySchema" with ${jsonTypeName(schema)}, not an array, so the answer is not the documented one; it is refused rather than read as absent`,
		);
	}
	const hash = schema.find(
		(entry) => isJsonObject(entry) && entry.KeyType === "HASH",
	);
	const actual = isJsonObject(hash)
		? answerString(hash, "AttributeName", label)
		: undefined;
	if (actual !== undefined && actual !== wanted) {
		return [
			`table partition key is ${actual} but the request asks for ${wanted}; a DynamoDB key schema is immutable and this resolver never replaces a table, so the drift is reported rather than corrected`,
		];
	}
	return [];
}

const DYNAMODB_SPEC: Omit<AwsResolverSpec, "productId"> = {
	settings: {
		billingMode: "string",
		readCapacity: "integer",
		writeCapacity: "integer",
		partitionKey: "string",
		partitionKeyType: "string",
		sortKey: "string",
		sortKeyType: "string",
	},
	async read(context) {
		const table = await readDynamoTable(context);
		if (table === undefined) return undefined;
		return outcome(
			settledAction(context),
			dynamoTableArn(table, `dynamodb describe table ${context.name}`),
			dynamoOutputs(table, context.name),
			dynamoKeyDiagnostics(context, table),
		);
	},
	async reconcile(context) {
		const billing = dynamoBilling(context);
		const diagnostics: string[] = [];
		const existing = await readDynamoTable(context);

		if (existing === undefined) {
			const partitionKey =
				optionalString(context.desired, "partitionKey") ?? "pk";
			if (optionalString(context.desired, "partitionKey") === undefined) {
				diagnostics.push(
					'no desired.partitionKey was declared, so the table was created with the attribute "pk" as its partition key; a DynamoDB table cannot exist without one and the key schema is immutable afterwards',
				);
			}
			if (billing.defaulted) {
				diagnostics.push(
					"no desired.billingMode was declared, so the table was created on-demand (PAY_PER_REQUEST), which bills per request rather than reserving capacity nobody asked for",
				);
			}
			const sortKey = optionalString(context.desired, "sortKey");
			const label = `dynamodb create table ${context.name}`;
			const readCapacity = billing.readCapacity;
			const writeCapacity = billing.writeCapacity;
			const created = jsonResult(
				context,
				await dynamoCall(context, "CreateTable", {
					TableName: context.name,
					AttributeDefinitions: [
						{
							AttributeName: partitionKey,
							AttributeType: dynamoKeyType(context, "partitionKeyType"),
						},
						...(sortKey === undefined
							? []
							: [
									{
										AttributeName: sortKey,
										AttributeType: dynamoKeyType(context, "sortKeyType"),
									},
								]),
					],
					KeySchema: [
						{ AttributeName: partitionKey, KeyType: "HASH" },
						...(sortKey === undefined
							? []
							: [{ AttributeName: sortKey, KeyType: "RANGE" }]),
					],
					BillingMode: billing.mode,
					...(billing.mode === "PROVISIONED" &&
					readCapacity !== undefined &&
					writeCapacity !== undefined
						? {
								ProvisionedThroughput: {
									ReadCapacityUnits: readCapacity,
									WriteCapacityUnits: writeCapacity,
								},
							}
						: undefined),
				}),
				label,
			);
			const description = answerRecord(created, "TableDescription", label);
			if (description === undefined) {
				throw unparseable(
					label,
					'AWS returned a successful CreateTable with no "TableDescription", so the created table cannot be identified',
				);
			}
			return outcome(
				"create",
				dynamoTableArn(description, label),
				dynamoOutputs(description, context.name),
				diagnostics,
			);
		}

		diagnostics.push(...dynamoKeyDiagnostics(context, existing));
		const observedMode = dynamoObservedMode(
			existing,
			`dynamodb describe table ${context.name}`,
		);
		if (!billing.defaulted && observedMode !== billing.mode) {
			const label = `dynamodb update table ${context.name}`;
			const readCapacity = billing.readCapacity;
			const writeCapacity = billing.writeCapacity;
			const updated = jsonResult(
				context,
				await dynamoCall(context, "UpdateTable", {
					TableName: context.name,
					BillingMode: billing.mode,
					...(billing.mode === "PROVISIONED" &&
					readCapacity !== undefined &&
					writeCapacity !== undefined
						? {
								ProvisionedThroughput: {
									ReadCapacityUnits: readCapacity,
									WriteCapacityUnits: writeCapacity,
								},
							}
						: undefined),
				}),
				label,
			);
			const description =
				answerRecord(updated, "TableDescription", label) ?? existing;
			return outcome(
				"update",
				dynamoTableArn(description, label),
				dynamoOutputs(description, context.name),
				diagnostics,
			);
		}

		return outcome(
			settledAction(context),
			dynamoTableArn(existing, `dynamodb describe table ${context.name}`),
			dynamoOutputs(existing, context.name),
			diagnostics,
		);
	},
	async remove(context) {
		const response = await dynamoCall(context, "DeleteTable", {
			TableName: context.name,
		});
		if (
			!isSuccess(response) &&
			jsonErrorCode(response.body) === "ResourceNotFoundException"
		) {
			return;
		}
		jsonResult(context, response, `dynamodb delete table ${context.name}`);
	},
};

// ---------------------------------------------------------------------------
// SQS queues — query protocol on sqs.{region}.amazonaws.com
// ---------------------------------------------------------------------------

// public-contract: the SQS query-protocol API version every request declares.
export const SQS_API_VERSION = "2012-11-05";

const QUERY_CONTENT_TYPE = "application/x-www-form-urlencoded; charset=utf-8";

const SQS_QUEUE_MISSING_CODE = "AWS.SimpleQueueService.NonExistentQueue";

/**
 * The query protocol numbers its attribute parameters from 1. Building the
 * list here rather than at each call site is what stops an off-by-one from
 * silently dropping the attribute that makes a queue FIFO.
 */
function sqsAttributeParameters(
	pairs: readonly (readonly [string, string])[],
): readonly (readonly [string, string])[] {
	const out: (readonly [string, string])[] = [];
	for (const [position, [name, value]] of pairs.entries()) {
		out.push(
			[`Attribute.${position + 1}.Name`, name],
			[`Attribute.${position + 1}.Value`, value],
		);
	}
	return out;
}

async function sqsCall(
	context: AwsResolverContext,
	parameters: readonly (readonly [string, string])[],
): Promise<TransportResponse> {
	return send(context, {
		service: "sqs",
		method: "POST",
		path: "/",
		headers: { "content-type": QUERY_CONTENT_TYPE },
		body: formBody([...parameters, ["Version", SQS_API_VERSION]]),
	});
}

/** FIFO queues must be named `*.fifo`; the suffix is part of the identity. */
function sqsQueueName(context: AwsResolverContext, fifo: boolean): string {
	if (!fifo) return context.name;
	return context.name.endsWith(".fifo") ? context.name : `${context.name}.fifo`;
}

function sqsIsFifo(context: AwsResolverContext, productId: string): boolean {
	return (
		productId === AWS_SQS_FIFO_PRODUCT_ID ||
		optionalBoolean(context.desired, "fifo") === true
	);
}

async function readSqsQueueUrl(
	context: AwsResolverContext,
	name: string,
): Promise<string | undefined> {
	const label = `sqs get queue url ${name}`;
	const response = await sqsCall(context, [
		["Action", "GetQueueUrl"],
		["QueueName", name],
	]);
	if (
		!isSuccess(response) &&
		xmlErrorCode(response.body) === SQS_QUEUE_MISSING_CODE
	) {
		return undefined;
	}
	const body = xmlResult(context, response, label);
	const url = xmlText(body, "QueueUrl");
	if (url === undefined) {
		throw unparseable(
			label,
			"AWS returned a successful GetQueueUrl with no <QueueUrl>, so the queue cannot be addressed",
		);
	}
	return url;
}

async function readSqsAttributes(
	context: AwsResolverContext,
	queueUrl: string,
): Promise<Readonly<Record<string, string>>> {
	const label = `sqs get queue attributes ${context.name}`;
	const body = xmlResult(
		context,
		await sqsCall(context, [
			["Action", "GetQueueAttributes"],
			["QueueUrl", queueUrl],
			["AttributeName.1", "All"],
		]),
		label,
	);
	const attributes: Record<string, string> = {};
	for (const block of xmlBlocks(body, "Attribute")) {
		const name = xmlText(block, "Name");
		const value = xmlText(block, "Value");
		if (name !== undefined && value !== undefined) attributes[name] = value;
	}
	return attributes;
}

function sqsOutputs(
	name: string,
	queueUrl: string,
	attributes: Readonly<Record<string, string>>,
	fifo: boolean,
): JsonObject {
	const arn = attributes.QueueArn;
	const visibility = attributes.VisibilityTimeout;
	return {
		queueName: name,
		queueUrl,
		fifo,
		...(arn === undefined ? undefined : { queueArn: arn }),
		...(visibility === undefined
			? undefined
			: { visibilityTimeoutSeconds: Number(visibility) }),
	};
}

function sqsDiagnostics(context: AwsResolverContext): readonly string[] {
	return optionalInteger(context.desired, "maxReceiveCount") === undefined
		? []
		: [
				"maxReceiveCount is declared but not applied: a redrive policy names a dead-letter queue ARN, and this resolver neither creates that queue nor guesses which one was meant",
			];
}

function sqsSpec(productId: string): Omit<AwsResolverSpec, "productId"> {
	return {
		settings: {
			fifo: "boolean",
			visibilityTimeoutSeconds: "integer",
			maxReceiveCount: "integer",
		},
		async read(context) {
			const fifo = sqsIsFifo(context, productId);
			const name = sqsQueueName(context, fifo);
			const queueUrl = await readSqsQueueUrl(context, name);
			if (queueUrl === undefined) return undefined;
			const attributes = await readSqsAttributes(context, queueUrl);
			return outcome(
				settledAction(context),
				queueUrl,
				sqsOutputs(name, queueUrl, attributes, fifo),
				sqsDiagnostics(context),
			);
		},
		async reconcile(context) {
			const fifo = sqsIsFifo(context, productId);
			const name = sqsQueueName(context, fifo);
			const visibility = optionalInteger(
				context.desired,
				"visibilityTimeoutSeconds",
			);
			let queueUrl = await readSqsQueueUrl(context, name);
			let action: ResolverAction = settledAction(context);

			if (queueUrl === undefined) {
				const label = `sqs create queue ${name}`;
				const attributeParameters = sqsAttributeParameters([
					...(fifo ? ([["FifoQueue", "true"]] as const) : []),
					...(visibility === undefined
						? []
						: ([["VisibilityTimeout", String(visibility)]] as const)),
				]);
				const body = xmlResult(
					context,
					await sqsCall(context, [
						["Action", "CreateQueue"],
						["QueueName", name],
						...attributeParameters,
					]),
					label,
				);
				const created = xmlText(body, "QueueUrl");
				if (created === undefined) {
					throw unparseable(
						label,
						"AWS returned a successful CreateQueue with no <QueueUrl>, so the created queue cannot be addressed",
					);
				}
				queueUrl = created;
				action = "create";
			} else if (visibility !== undefined) {
				const attributes = await readSqsAttributes(context, queueUrl);
				if (attributes.VisibilityTimeout !== String(visibility)) {
					xmlResult(
						context,
						await sqsCall(context, [
							["Action", "SetQueueAttributes"],
							["QueueUrl", queueUrl],
							["Attribute.1.Name", "VisibilityTimeout"],
							["Attribute.1.Value", String(visibility)],
						]),
						`sqs set queue attributes ${name}`,
					);
					action = "update";
				}
			}

			const attributes = await readSqsAttributes(context, queueUrl);
			return outcome(
				action,
				queueUrl,
				sqsOutputs(name, queueUrl, attributes, fifo),
				sqsDiagnostics(context),
			);
		},
		async remove(context) {
			const fifo = sqsIsFifo(context, productId);
			const name = sqsQueueName(context, fifo);
			const queueUrl = await readSqsQueueUrl(context, name);
			if (queueUrl === undefined) return;
			const response = await sqsCall(context, [
				["Action", "DeleteQueue"],
				["QueueUrl", queueUrl],
			]);
			if (
				!isSuccess(response) &&
				xmlErrorCode(response.body) === SQS_QUEUE_MISSING_CODE
			) {
				return;
			}
			xmlResult(context, response, `sqs delete queue ${name}`);
		},
	};
}

// ---------------------------------------------------------------------------
// SNS topics — query protocol on sns.{region}.amazonaws.com
// ---------------------------------------------------------------------------

// public-contract: the SNS query-protocol API version every request declares.
export const SNS_API_VERSION = "2010-03-31";

/** A listing that will not terminate is refused rather than half-read. */
const MAX_LIST_PAGES = 25;

/** SNS spells its attribute map `Attributes.entry.N.key` / `.value`. */
function snsAttributeParameters(
	pairs: readonly (readonly [string, string])[],
): readonly (readonly [string, string])[] {
	const out: (readonly [string, string])[] = [];
	for (const [position, [name, value]] of pairs.entries()) {
		out.push(
			[`Attributes.entry.${position + 1}.key`, name],
			[`Attributes.entry.${position + 1}.value`, value],
		);
	}
	return out;
}

async function snsCall(
	context: AwsResolverContext,
	parameters: readonly (readonly [string, string])[],
): Promise<TransportResponse> {
	return send(context, {
		service: "sns",
		method: "POST",
		path: "/",
		headers: { "content-type": QUERY_CONTENT_TYPE },
		body: formBody([...parameters, ["Version", SNS_API_VERSION]]),
	});
}

function snsTopicName(context: AwsResolverContext, fifo: boolean): string {
	if (!fifo) return context.name;
	return context.name.endsWith(".fifo") ? context.name : `${context.name}.fifo`;
}

/**
 * SNS has no get-topic-by-name, so convergence rides on a bounded paged
 * `ListTopics` matched on the last ARN segment. Stopping at page one would
 * mean creating a duplicate of a topic that already exists on page two, which
 * is precisely the failure convergence is supposed to rule out — so a listing
 * that does not terminate is a refusal, not a "probably fine".
 */
async function findSnsTopicArn(
	context: AwsResolverContext,
	name: string,
): Promise<string | undefined> {
	const label = `sns list topics for ${name}`;
	let nextToken: string | undefined;
	for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
		const parameters: (readonly [string, string])[] = [
			["Action", "ListTopics"],
		];
		if (nextToken !== undefined) parameters.push(["NextToken", nextToken]);
		const body = xmlResult(context, await snsCall(context, parameters), label);
		for (const arn of xmlTexts(body, "TopicArn")) {
			if (arn.slice(arn.lastIndexOf(":") + 1) === name) return arn;
		}
		nextToken = xmlText(body, "NextToken");
		if (nextToken === undefined) return undefined;
	}
	throw new ResolverError(
		"RESOLVER_PROVIDER_REJECTED",
		`${label}: the SNS topic listing did not terminate within ${MAX_LIST_PAGES} pages, so an existing topic cannot be ruled out and creating one would risk a duplicate`,
	);
}

async function readSnsAttributes(
	context: AwsResolverContext,
	topicArn: string,
): Promise<Readonly<Record<string, string>>> {
	const body = xmlResult(
		context,
		await snsCall(context, [
			["Action", "GetTopicAttributes"],
			["TopicArn", topicArn],
		]),
		`sns get topic attributes ${context.name}`,
	);
	const attributes: Record<string, string> = {};
	for (const entry of xmlBlocks(body, "entry")) {
		const key = xmlText(entry, "key");
		const value = xmlText(entry, "value");
		if (key !== undefined && value !== undefined) attributes[key] = value;
	}
	return attributes;
}

function snsOutputs(
	name: string,
	topicArn: string,
	attributes: Readonly<Record<string, string>>,
	fifo: boolean,
): JsonObject {
	const dedupe = attributes.ContentBasedDeduplication;
	return {
		topicName: name,
		topicArn,
		fifo,
		...(dedupe === undefined
			? undefined
			: { contentBasedDeduplication: dedupe }),
	};
}

const SNS_SPEC: Omit<AwsResolverSpec, "productId"> = {
	settings: { fifo: "boolean", contentBasedDeduplication: "boolean" },
	async read(context) {
		const fifo = optionalBoolean(context.desired, "fifo") === true;
		const name = snsTopicName(context, fifo);
		const topicArn = await findSnsTopicArn(context, name);
		if (topicArn === undefined) return undefined;
		const attributes = await readSnsAttributes(context, topicArn);
		return outcome(
			settledAction(context),
			topicArn,
			snsOutputs(name, topicArn, attributes, fifo),
			[],
		);
	},
	async reconcile(context) {
		const fifo = optionalBoolean(context.desired, "fifo") === true;
		const name = snsTopicName(context, fifo);
		const dedupe = optionalBoolean(
			context.desired,
			"contentBasedDeduplication",
		);
		let topicArn = await findSnsTopicArn(context, name);
		let action: ResolverAction = settledAction(context);

		if (topicArn === undefined) {
			const label = `sns create topic ${name}`;
			const attributeParameters = snsAttributeParameters([
				...(fifo ? ([["FifoTopic", "true"]] as const) : []),
				...(dedupe === undefined
					? []
					: ([["ContentBasedDeduplication", String(dedupe)]] as const)),
			]);
			const body = xmlResult(
				context,
				await snsCall(context, [
					["Action", "CreateTopic"],
					["Name", name],
					...attributeParameters,
				]),
				label,
			);
			const created = xmlText(body, "TopicArn");
			if (created === undefined) {
				throw unparseable(
					label,
					"AWS returned a successful CreateTopic with no <TopicArn>, so the created topic cannot be addressed",
				);
			}
			topicArn = created;
			action = "create";
		} else if (dedupe !== undefined) {
			const attributes = await readSnsAttributes(context, topicArn);
			if (attributes.ContentBasedDeduplication !== String(dedupe)) {
				xmlResult(
					context,
					await snsCall(context, [
						["Action", "SetTopicAttributes"],
						["TopicArn", topicArn],
						["AttributeName", "ContentBasedDeduplication"],
						["AttributeValue", String(dedupe)],
					]),
					`sns set topic attributes ${name}`,
				);
				action = "update";
			}
		}

		const attributes = await readSnsAttributes(context, topicArn);
		return outcome(
			action,
			topicArn,
			snsOutputs(name, topicArn, attributes, fifo),
			[],
		);
	},
	async remove(context) {
		const fifo = optionalBoolean(context.desired, "fifo") === true;
		const name = snsTopicName(context, fifo);
		const topicArn = await findSnsTopicArn(context, name);
		if (topicArn === undefined) return;
		const response = await snsCall(context, [
			["Action", "DeleteTopic"],
			["TopicArn", topicArn],
		]);
		if (!isSuccess(response) && xmlErrorCode(response.body) === "NotFound") {
			return;
		}
		xmlResult(context, response, `sns delete topic ${name}`);
	},
};

// ---------------------------------------------------------------------------
// Secrets Manager — REST-JSON with an x-amz-target header
// ---------------------------------------------------------------------------

const JSON_1_1_CONTENT_TYPE = "application/x-amz-json-1.1";
const SECRETS_TARGET_PREFIX = "secretsmanager";

async function secretsCall(
	context: AwsResolverContext,
	operation: string,
	payload: JsonObject,
): Promise<TransportResponse> {
	return send(context, {
		service: "secretsmanager",
		method: "POST",
		path: "/",
		headers: {
			"content-type": JSON_1_1_CONTENT_TYPE,
			"x-amz-target": `${SECRETS_TARGET_PREFIX}.${operation}`,
		},
		body: JSON.stringify(payload),
	});
}

/** DescribeSecret's answer, unparsed: the record and the body it was read from. */
interface SecretDescription {
	readonly record: JsonObject;
	readonly body: string;
}

/**
 * A secret as DescribeSecret answered it, with `DeletedDate` parsed: the
 * canonical instant while the secret is scheduled for deletion, `undefined`
 * while it is live. Nothing past this boundary reads `record.DeletedDate`.
 */
interface DescribedSecret {
	readonly record: JsonObject;
	readonly deletedDate: string | undefined;
}

/** DescribeSecret for this secret, or `undefined` when AWS has no such secret. */
async function describeSecret(
	context: AwsResolverContext,
): Promise<SecretDescription | undefined> {
	const response = await secretsCall(context, "DescribeSecret", {
		SecretId: context.name,
	});
	if (
		!isSuccess(response) &&
		jsonErrorCode(response.body) === "ResourceNotFoundException"
	) {
		return undefined;
	}
	const record = jsonResult(
		context,
		response,
		`secretsmanager describe ${context.name}`,
	);
	return { record, body: response.body };
}

/** The secret, described and parsed; `undefined` when there is none. */
async function readSecret(
	context: AwsResolverContext,
): Promise<DescribedSecret | undefined> {
	const described = await describeSecret(context);
	if (described === undefined) return undefined;
	return {
		record: described.record,
		deletedDate: parseDeletedDate(context, described),
	};
}

/** 0000-01-01T00:00:00.000Z and 9999-12-31T23:59:59.999Z: four-digit years. */
const FIRST_INSTANT_MS = -62167219200000;
const LAST_INSTANT_MS = 253402300799999;

/**
 * RFC 3339 `date-time` (section 5.6): `T` and `Z` in either case (section
 * 5.6's NOTE) and any number of fraction digits (`time-secfrac = "." 1*DIGIT`).
 * The grammar's seconds field also allows 60 for a leap second; that is
 * matched here and refused by {@link instantFromRfc3339}.
 */
const RFC3339_DATE_TIME =
	/^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/u;

/**
 * Days in a month of the proleptic Gregorian calendar RFC 3339 uses, and 0 for
 * a month outside 01-12, so no day of it is in range.
 */
function daysInMonth(year: number, month: number): number {
	const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
	return (
		[31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0
	);
}

/**
 * A fraction of a second, canonical: kept to the nanosecond (nine digits;
 * digits past the ninth are dropped), at least three digits, and no trailing
 * zero past the third. So `.5`, `.500` and `.5000` are one value, `.500`.
 */
function canonicalFraction(digits: string): string {
	let fraction = digits.slice(0, 9).padEnd(3, "0");
	while (fraction.length > 3 && fraction.endsWith("0")) {
		fraction = fraction.slice(0, -1);
	}
	return fraction;
}

/** The years 0000 to 9999 in epoch seconds: from the first second, up to the end. */
const FIRST_SECOND = -62167219200n;
const END_SECOND = 253402300800n;

/**
 * A JSON number (RFC 8259 section 6) in decimal parts: sign, whole digits,
 * fraction digits, exponent. At most 40 whole digits and 40 fraction digits;
 * the exponent's text may have up to three digits, and its value is capped at
 * 40 either way in {@link instantFromEpochSeconds}. That is far past any epoch
 * seconds in the years 0000 to 9999 AWS would write, and it keeps the exact
 * arithmetic small. A number past either bound is refused even when its value
 * is in range (`1e-41`, or a fraction of 41 digits).
 */
const JSON_NUMBER =
	/^(-?)(0|[1-9]\d{0,39})(?:\.(\d{1,40}))?(?:[eE]([+-]?\d{1,3}))?$/u;

/**
 * Epoch seconds, AWS's JSON-protocol timestamp, as the canonical instant,
 * computed from the number's decimal text, not from the binary double it
 * parses to (which would make `1523477145.72949999` round as `.7295`).
 *
 * The exact value must lie in the years 0000 to 9999 before it is rounded, so
 * `-62167219200.0004` is refused. It is then rounded half up, toward +∞, to
 * the millisecond: `.7295` is `.730`, and `-1.0005` is `-1.000`. The rounded
 * instant must still be in 9999, so `253402300799.9995` is refused. AWS writes
 * at most milliseconds (`1523477145.729`). `undefined` for anything else,
 * including text that is not a JSON number (`Infinity`).
 */
function instantFromEpochSeconds(text: string): string | undefined {
	const match = JSON_NUMBER.exec(text);
	if (match === null) return undefined;
	const exponent = Number(match[4] ?? "0");
	if (Math.abs(exponent) > 40) return undefined;
	const fraction = match[3] ?? "";
	// The value is exactly digits / 10^scale.
	const digits = BigInt(`${match[1] ?? ""}${match[2] ?? "0"}${fraction}`);
	const scale = fraction.length - exponent;
	const whole = Math.max(scale, 0);
	const scaled = digits * 10n ** BigInt(whole - scale);
	const unit = 10n ** BigInt(whole);
	if (scaled < FIRST_SECOND * unit || scaled >= END_SECOND * unit) {
		return undefined;
	}
	const msScale = scale - 3;
	let ms = digits * 10n ** BigInt(Math.max(-msScale, 0));
	if (msScale > 0) {
		const divisor = 10n ** BigInt(msScale);
		const floor =
			digits >= 0n ? digits / divisor : -((-digits + divisor - 1n) / divisor);
		const halfOrMore = 2n * (digits - floor * divisor) >= divisor;
		ms = floor + (halfOrMore ? 1n : 0n);
	}
	if (ms > BigInt(LAST_INSTANT_MS)) return undefined;
	return new Date(Number(ms)).toISOString();
}

/**
 * An RFC 3339 date-time as the canonical instant, or `undefined` when it is
 * not one: a field out of its range (month 01-12, day 01 to the month's last,
 * hour 00-23, minute 00-59, second 00-59, offset hour 00-23 and minute 00-59),
 * or an instant outside the years 0000 to 9999 once its offset is applied.
 *
 * A leap second (second 60) is refused. AWS's epoch-seconds timestamps cannot
 * carry one; RFC 3339 allows one only where a leap second actually occurred;
 * and `…:60.000Z` is an output `Date.parse` cannot read, so a consumer of
 * `outputs.deletedDate` would get NaN.
 *
 * The date and time are moved to UTC by whole-second arithmetic; the fraction
 * is carried as text, never through a number.
 */
function instantFromRfc3339(text: string): string | undefined {
	const match = RFC3339_DATE_TIME.exec(text);
	if (match === null) return undefined;
	// Groups 1-6 are the date and time, 7 the fraction, 8-10 the offset's sign,
	// hour and minute. "Z" leaves 8-10 unset, which reads as +00:00; a group
	// the pattern requires defaults to a value its range check refuses.
	const field = (index: number, absent: number): number => {
		const digits = match[index];
		return digits === undefined ? absent : Number(digits);
	};
	const year = field(1, 0);
	const month = field(2, 0);
	const day = field(3, 0);
	const hour = field(4, 24);
	const minute = field(5, 60);
	const second = field(6, 61);
	const fraction = match[7] ?? "";
	const sign = match[8];
	const offsetHour = field(9, 0);
	const offsetMinute = field(10, 0);
	// The month needs no check of its own: daysInMonth is 0 outside 01-12.
	const inRange =
		day >= 1 &&
		day <= daysInMonth(year, month) &&
		hour <= 23 &&
		minute <= 59 &&
		second <= 59 &&
		offsetHour <= 23 &&
		offsetMinute <= 59;
	if (!inRange) return undefined;
	const local = new Date(0);
	local.setUTCFullYear(year, month - 1, day);
	local.setUTCHours(hour, minute, second, 0);
	const offsetMinutes =
		(sign === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute);
	const utcMs = local.getTime() - offsetMinutes * 60_000;
	if (utcMs < FIRST_INSTANT_MS || utcMs > LAST_INSTANT_MS) return undefined;
	const iso = new Date(utcMs).toISOString();
	return `${iso.slice(0, 19)}.${canonicalFraction(fraction)}Z`;
}

/**
 * The JSON text a top-level member of `body` was written as, where the
 * runtime gives a reviver the source text (ES2025 JSON.parse source text
 * access); otherwise `undefined`. A value JSON.parse cannot hold, such as
 * `1e400` (read as Infinity, written back as `null`), is quoted as it arrived.
 */
function memberSource(body: string, key: string): string | undefined {
	// The body already parsed as JSON (jsonResult), so every value and holder
	// the reviver sees is a JSON value.
	const sources: { holder: JsonValue; source: string }[] = [];
	const root: JsonValue = JSON.parse(
		body,
		function collect(
			this: JsonValue,
			name: string,
			value: JsonValue,
			context?: { readonly source?: string },
		): JsonValue {
			if (name === key && context?.source !== undefined) {
				sources.push({ holder: this, source: context.source });
			}
			return value;
		},
	);
	return sources.find((entry) => entry.holder === root)?.source;
}

/**
 * DescribeSecret's `DeletedDate`, parsed where the answer is read.
 *
 * - **Absent, or `null`: not scheduled.** The API omits the field when the
 *   secret "is not scheduled for deletion", and Smithy's JSON protocols read a
 *   `null` member as one not sent.
 * - **A number: epoch seconds**, AWS's JSON-protocol timestamp.
 * - **A string: an RFC 3339 date-time**, the form a provider that answers text
 *   writes ("2026-11-30T05:30:25.033060027Z").
 *
 * Either is reported as one canonical ISO 8601 instant, in UTC:
 * `YYYY-MM-DDTHH:MM:SS.fffZ`, upper-case `T` and `Z`, a four-digit year, any
 * offset (`-00:00` included) applied, and the fraction as
 * {@link canonicalFraction} keeps it. A number is rounded to the millisecond;
 * a leap second (second 60) is refused. Anything else is unreadable, and the
 * secret's state with it, so it is refused rather than guessed at. The
 * refusal quotes a number as it was written and anything else as the value it
 * parsed to, bounded and redacted like any provider text.
 *
 * Nothing more is read into the date than the API says. DescribeSecret calls it
 * "The date the secret is scheduled for deletion"; DeleteSecret's
 * `DeletionDate`, the end of the recovery window, is "the date and time of the
 * delete request plus the number of days in RecoveryWindowInDays", and the API
 * does not say the two are equal. So the date is reported as `DeletedDate`,
 * never as the day the secret will be gone.
 */
function parseDeletedDate(
	context: AwsResolverContext,
	described: SecretDescription,
): string | undefined {
	const value = described.record.DeletedDate;
	if (value === undefined || value === null) return undefined;
	// A number is read from its decimal text, as the response wrote it; a
	// runtime without JSON.parse source text access falls back to the number's
	// shortest decimal form.
	const numberText = isJsonNumber(value)
		? (memberSource(described.body, "DeletedDate") ?? String(value))
		: undefined;
	const instant =
		numberText !== undefined
			? instantFromEpochSeconds(numberText)
			: isJsonString(value)
				? instantFromRfc3339(value)
				: undefined;
	if (instant !== undefined) return instant;
	// A number is quoted as the response wrote it, because JSON.parse cannot
	// hold every number (1e400 reads back as Infinity and is written as null)
	// and a number's text has no escapes. Anything else is quoted as the value
	// it parsed to: its source text could spell a credential in \u escapes,
	// which neither the exact-match nor the token scrub would see.
	const written = numberText ?? JSON.stringify(value);
	// A leap second only when second 60 is the one thing wrong: the same text
	// with second 59 must be a date-time this parser accepts. "2026-13-45T…:60Z"
	// gets the general refusal, because its date is wrong too.
	const leapSecond =
		isJsonString(value) &&
		RFC3339_DATE_TIME.exec(value)?.[6] === "60" &&
		instantFromRfc3339(`${value.slice(0, 17)}59${value.slice(19)}`) !==
			undefined;
	const what = leapSecond
		? "is a leap second (second 60), which no AWS timestamp carries and which Date.parse cannot read"
		: "is neither epoch seconds nor an RFC 3339 date-time in the years 0000 to 9999";
	throw unparseable(
		`secretsmanager describe ${context.name}`,
		`AWS returned a DeletedDate (${context.redact(written, 80)}) that ${what}, so whether the secret is scheduled for deletion cannot be read; it is refused rather than assumed`,
	);
}

/**
 * The Secrets Manager declarations that say how apply and delete act, never
 * what the secret is: `forceDelete` ends the recovery window on delete, and
 * `restoreScheduled` lets apply restore a secret scheduled for deletion.
 */
const SECRETS_MANAGER_DIRECTIVES: readonly string[] = Object.freeze([
	"forceDelete",
	"restoreScheduled",
]);

/** Whether the declaration asks for a secret scheduled for deletion to be restored. */
function restoreDeclared(context: AwsResolverContext): boolean {
	return context.directivesOn.has("restoreScheduled");
}

/** What apply will do with a secret scheduled for deletion, in one sentence. */
function scheduledNote(
	context: AwsResolverContext,
	deletedDate: string,
): string {
	const scheduled = `the secret is scheduled for deletion (DeletedDate ${deletedDate})`;
	return restoreDeclared(context)
		? `${scheduled}; apply will restore it, with its previous versions (restoreScheduled: true)`
		: `${scheduled}; apply refuses it: declare restoreScheduled: true to restore it with its previous versions, or destroy it with forceDelete: true to delete it now`;
}

function secretArn(record: JsonObject, label: string): string {
	const arn = answerString(record, "ARN", label);
	if (arn === undefined) {
		throw unparseable(
			label,
			'AWS returned a secret record without an "ARN", so the secret cannot be addressed',
		);
	}
	return arn;
}

function secretOutputs(name: string, record: JsonObject): JsonObject {
	const label = `secretsmanager ${name}`;
	const description = answerString(record, "Description", label);
	const kmsKeyId = answerString(record, "KmsKeyId", label);
	// The keys are `name`/`arn` rather than `secretName`/`secretArn`: core's
	// outcome parse boundary refuses any property key matching /secret/, because
	// a bag key that reads like a secret is exactly where material hides. The
	// bag belongs to a Secrets Manager outcome, so the plain names are
	// unambiguous without the prefix.
	return {
		name,
		arn: answerString(record, "ARN", label) ?? "",
		...(description === undefined ? undefined : { description }),
		// A KMS key id is a locator for a key, not key material, so it belongs in
		// outputs the way a bucket name does.
		...(kmsKeyId === undefined ? undefined : { kmsKeyId }),
	};
}

function secretDiagnostics(context: AwsResolverContext): readonly string[] {
	const diagnostics: string[] = [];
	if (optionalInteger(context.desired, "rotationDays") !== undefined) {
		diagnostics.push(
			"rotationDays is declared but not applied: RotateSecret needs a rotation Lambda this resolver neither creates nor selects",
		);
	}
	return diagnostics;
}

const SECRETS_MANAGER_SPEC: Omit<AwsResolverSpec, "productId"> = {
	// Neither is a fact about the secret, so read() never reports one, and a
	// preview or drift check leaves them out of its comparison (ADR-0175).
	directives: SECRETS_MANAGER_DIRECTIVES,
	settings: {
		description: "string",
		kmsKeyRef: "string",
		rotationDays: "integer",
	},
	async read(context) {
		const secret = await readSecret(context);
		if (secret === undefined) return undefined;
		const existing = secret.record;
		// A secret scheduled for deletion still exists and still holds its name,
		// so it is reported, not hidden: as `delete` (the provider is deleting
		// it), with the date and what apply will do. Reporting it absent would
		// tell a preview that apply creates it, which CreateSecret refuses.
		const { deletedDate } = secret;
		if (deletedDate !== undefined) {
			return outcome(
				"delete",
				secretArn(existing, `secretsmanager describe ${context.name}`),
				{ ...secretOutputs(context.name, existing), deletedDate },
				[scheduledNote(context, deletedDate), ...secretDiagnostics(context)],
			);
		}
		return outcome(
			settledAction(context),
			secretArn(existing, `secretsmanager describe ${context.name}`),
			secretOutputs(context.name, existing),
			secretDiagnostics(context),
		);
	},
	async reconcile(context) {
		const description = optionalString(context.desired, "description");
		const kmsKeyRef = optionalString(context.desired, "kmsKeyRef");
		const diagnostics = [...secretDiagnostics(context)];
		const secret = await readSecret(context);
		let existing = secret?.record;
		let restored = false;
		const deletedDate = secret?.deletedDate;

		if (existing !== undefined && deletedDate !== undefined) {
			// CreateSecret cannot take the name back while the deletion is pending.
			// Someone deleted this secret on purpose, so bringing it back is the
			// declaration's call, never a default: without restoreScheduled this
			// fails closed and says how to proceed.
			if (!restoreDeclared(context)) {
				throw new ResolverError(
					"RESOLVER_PROVIDER_REJECTED",
					`secretsmanager ${context.name}: ${scheduledNote(context, deletedDate)}`,
				);
			}
			// RestoreSecret "Cancels the scheduled deletion of a secret by removing
			// the DeletedDate time stamp", and keeps the versions written out of band.
			jsonResult(
				context,
				await secretsCall(context, "RestoreSecret", {
					SecretId: context.name,
				}),
				`secretsmanager restore ${context.name}`,
			);
			// A success is believed only once DescribeSecret agrees. If the secret
			// is still scheduled (or gone), an UpdateSecret now would be refused
			// for a reason the operator never sees, and an `update` outcome would
			// claim a restore that did not happen; both are refused here instead.
			const after = await readSecret(context);
			const stillScheduled = after?.deletedDate;
			if (after === undefined || stillScheduled !== undefined) {
				throw new ResolverError(
					"RESOLVER_PROVIDER_REJECTED",
					`secretsmanager restore ${context.name}: RestoreSecret answered success, but the restore did not take effect: DescribeSecret ${
						after === undefined
							? "no longer finds the secret"
							: `still reports it scheduled for deletion (DeletedDate ${stillScheduled})`
					}. Nothing more was sent; run apply again once DescribeSecret shows the secret restored`,
				);
			}
			diagnostics.push(
				`restored the secret scheduled for deletion (DeletedDate ${deletedDate}), with its previous versions (restoreScheduled: true)`,
			);
			existing = after.record;
			restored = true;
		}

		if (existing === undefined) {
			const label = `secretsmanager create ${context.name}`;
			// Deliberately no SecretString/SecretBinary: this resolver creates the
			// container and never carries the value. Writing a version is a
			// separate, host-side act with the material in hand.
			const created = jsonResult(
				context,
				await secretsCall(context, "CreateSecret", {
					Name: context.name,
					...(description === undefined
						? undefined
						: { Description: description }),
					...(kmsKeyRef === undefined ? undefined : { KmsKeyId: kmsKeyRef }),
				}),
				label,
			);
			diagnostics.push(
				"the secret was created with no version: this resolver never holds credential material, so the value is written out of band by whoever has it",
			);
			return outcome(
				"create",
				secretArn(created, label),
				secretOutputs(context.name, created),
				diagnostics,
			);
		}

		const descriptionDrift =
			description !== undefined &&
			description !==
				answerString(
					existing,
					"Description",
					`secretsmanager describe ${context.name}`,
				);
		const keyDrift =
			kmsKeyRef !== undefined &&
			kmsKeyRef !==
				answerString(
					existing,
					"KmsKeyId",
					`secretsmanager describe ${context.name}`,
				);
		if (descriptionDrift || keyDrift) {
			const label = `secretsmanager update ${context.name}`;
			jsonResult(
				context,
				await secretsCall(context, "UpdateSecret", {
					SecretId: context.name,
					...(descriptionDrift ? { Description: description } : undefined),
					...(keyDrift ? { KmsKeyId: kmsKeyRef } : undefined),
				}),
				label,
			);
			const refreshed = (await readSecret(context))?.record ?? existing;
			return outcome(
				"update",
				secretArn(refreshed, label),
				secretOutputs(context.name, refreshed),
				diagnostics,
			);
		}

		return outcome(
			restored ? "update" : settledAction(context),
			secretArn(existing, `secretsmanager describe ${context.name}`),
			secretOutputs(context.name, existing),
			diagnostics,
		);
	},
	async remove(context) {
		const force = context.directivesOn.has("forceDelete");
		if (force) {
			// A forced delete ends the recovery window whatever DeletedDate says,
			// so it asks DescribeSecret only whether the secret exists, and an
			// unreadable DeletedDate does not stop it. Nothing the describe answers
			// chooses what is deleted: both calls name the secret by SecretId.
			if ((await describeSecret(context)) === undefined) return;
		} else {
			// Already being deleted: a second unforced DeleteSecret is
			// InvalidRequestException, and there is nothing more to ask for. An
			// unreadable DeletedDate is refused here, since this needs to know.
			const existing = await readSecret(context);
			if (existing === undefined || existing.deletedDate !== undefined) return;
		}
		const response = await secretsCall(context, "DeleteSecret", {
			SecretId: context.name,
			...(force ? { ForceDeleteWithoutRecovery: true } : undefined),
		});
		if (!isSuccess(response)) {
			const code = jsonErrorCode(response.body);
			if (code === "ResourceNotFoundException") return;
			// InvalidRequestException has more than one cause, so it is checked,
			// not matched by its wording: if the secret is now scheduled for
			// deletion (someone deleted it between the describe and this call),
			// the deletion this asked for is already under way.
			if (code === "InvalidRequestException" && !force) {
				const now = await readSecret(context);
				if (now === undefined || now.deletedDate !== undefined) return;
			}
		}
		jsonResult(context, response, `secretsmanager delete ${context.name}`);
	},
};

// ---------------------------------------------------------------------------
// SSM Parameter Store — REST-JSON with an x-amz-target header
// ---------------------------------------------------------------------------

const SSM_TARGET_PREFIX = "AmazonSSM";
const SSM_PARAMETER_TYPES = Object.freeze(["String", "StringList"] as const);

async function ssmCall(
	context: AwsResolverContext,
	operation: string,
	payload: JsonObject,
): Promise<TransportResponse> {
	return send(context, {
		service: "ssm",
		method: "POST",
		path: "/",
		headers: {
			"content-type": JSON_1_1_CONTENT_TYPE,
			"x-amz-target": `${SSM_TARGET_PREFIX}.${operation}`,
		},
		body: JSON.stringify(payload),
	});
}

/**
 * `SecureString` is refused, not supported.
 *
 * A SecureString parameter's value *is* the secret, and `PutParameter` takes
 * it inline — which would mean the material travelled in
 * `ResolveRequest.desired`, the record that reaches the event log and the plan
 * digest. This resolver therefore manages only non-secret parameters, and says
 * so rather than quietly downgrading the type.
 */
function ssmParameterType(
	context: AwsResolverContext,
): "String" | "StringList" {
	const declared = optionalString(context.desired, "type") ?? "String";
	switch (declared) {
		case "String":
		case "StringList":
			return declared;
		default:
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				declared === "SecureString"
					? `${AWS_SSM_PARAMETER_PRODUCT_ID}: desired.type "SecureString" is refused. Its value is the secret, and PutParameter takes that value inline — it would travel in the request record, the event log, and the plan digest. Write SecureString parameters out of band with the material in hand and let this resolver manage only non-secret parameters`
					: `${AWS_SSM_PARAMETER_PRODUCT_ID}: desired.type must be one of ${SSM_PARAMETER_TYPES.join(" | ")}, received ${JSON.stringify(declared)}`,
				AWS_SSM_PARAMETER_PRODUCT_ID,
			);
	}
}

function ssmParameterValue(context: AwsResolverContext): string {
	const value = context.desired.value;
	if (!isJsonString(value) || value.length === 0) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${AWS_SSM_PARAMETER_PRODUCT_ID}: desired.value is required and must be a non-empty string. A parameter cannot exist without a value, and inventing a placeholder would write a fact into the account that nobody stated`,
			AWS_SSM_PARAMETER_PRODUCT_ID,
		);
	}
	return value;
}

async function readSsmParameter(
	context: AwsResolverContext,
): Promise<JsonObject | undefined> {
	const label = `ssm get parameter ${context.name}`;
	const response = await ssmCall(context, "GetParameter", {
		Name: context.name,
		WithDecryption: false,
	});
	if (
		!isSuccess(response) &&
		jsonErrorCode(response.body) === "ParameterNotFound"
	) {
		return undefined;
	}
	const body = jsonResult(context, response, label);
	const parameter = answerRecord(body, "Parameter", label);
	if (parameter === undefined) {
		throw unparseable(
			label,
			'AWS returned a successful GetParameter with no "Parameter" object, so the parameter cannot be identified',
		);
	}
	return parameter;
}

function ssmOutputs(
	name: string,
	parameter: JsonObject | undefined,
	tier: string | undefined,
): JsonObject {
	const label = `ssm parameter ${name}`;
	const arn =
		parameter === undefined ? undefined : answerString(parameter, "ARN", label);
	const type =
		parameter === undefined
			? undefined
			: answerString(parameter, "Type", label);
	return {
		parameterName: name,
		...(arn === undefined ? undefined : { parameterArn: arn }),
		...(type === undefined ? undefined : { parameterType: type }),
		...(tier === undefined ? undefined : { parameterTier: tier }),
	};
}

function ssmDiagnostics(context: AwsResolverContext): readonly string[] {
	return optionalString(context.desired, "kmsKeyRef") === undefined
		? []
		: [
				"kmsKeyRef is declared but not applied: a KMS key only encrypts a SecureString parameter, and this resolver refuses SecureString because its value would travel in the request record",
			];
}

const SSM_PARAMETER_SPEC: Omit<AwsResolverSpec, "productId"> = {
	settings: {
		type: "string",
		tier: "string",
		kmsKeyRef: "string",
		value: "string",
	},
	async read(context) {
		const parameter = await readSsmParameter(context);
		if (parameter === undefined) return undefined;
		return outcome(
			settledAction(context),
			context.name,
			ssmOutputs(context.name, parameter, undefined),
			ssmDiagnostics(context),
		);
	},
	async reconcile(context) {
		const type = ssmParameterType(context);
		const value = ssmParameterValue(context);
		const tier = optionalString(context.desired, "tier");
		const awsTier =
			tier === undefined
				? undefined
				: tier === "advanced"
					? "Advanced"
					: "Standard";
		const existing = await readSsmParameter(context);

		if (existing !== undefined) {
			const diagnostics = [...ssmDiagnostics(context)];
			const answered = `ssm get parameter ${context.name}`;
			const observedType = answerString(existing, "Type", answered);
			if (observedType !== undefined && observedType !== type) {
				diagnostics.push(
					`parameter type is ${observedType} but the request asks for ${type}; SSM does not allow a type change on overwrite, so the drift is reported rather than forced`,
				);
			}
			if (answerString(existing, "Value", answered) === value) {
				return outcome(
					settledAction(context),
					context.name,
					ssmOutputs(context.name, existing, awsTier),
					diagnostics,
				);
			}
			jsonResult(
				context,
				await ssmCall(context, "PutParameter", {
					Name: context.name,
					Value: value,
					Type: type,
					Overwrite: true,
					...(awsTier === undefined ? undefined : { Tier: awsTier }),
				}),
				`ssm put parameter ${context.name}`,
			);
			const refreshed = (await readSsmParameter(context)) ?? existing;
			return outcome(
				"update",
				context.name,
				ssmOutputs(context.name, refreshed, awsTier),
				diagnostics,
			);
		}

		jsonResult(
			context,
			await ssmCall(context, "PutParameter", {
				Name: context.name,
				Value: value,
				Type: type,
				Overwrite: false,
				...(awsTier === undefined ? undefined : { Tier: awsTier }),
			}),
			`ssm put parameter ${context.name}`,
		);
		// PutParameter answers with a version, not an ARN. Reading back is what
		// makes the outputs of a create identical to the outputs of the reconcile
		// that follows it.
		const created = await readSsmParameter(context);
		return outcome(
			"create",
			context.name,
			ssmOutputs(context.name, created, awsTier),
			ssmDiagnostics(context),
		);
	},
	async remove(context) {
		const response = await ssmCall(context, "DeleteParameter", {
			Name: context.name,
		});
		if (
			!isSuccess(response) &&
			jsonErrorCode(response.body) === "ParameterNotFound"
		) {
			return;
		}
		jsonResult(context, response, `ssm delete parameter ${context.name}`);
	},
};

// ---------------------------------------------------------------------------
// Lambda container-image functions — REST API model 2015-03-31.
// ---------------------------------------------------------------------------

function lambdaPath(context: AwsResolverContext, suffix = ""): string {
	if (!/^[A-Za-z0-9_-]{1,64}$/u.test(context.name))
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Lambda function name must be an explicit bounded identifier",
		);
	return `/2015-03-31/functions/${encodeComponent(context.name)}${suffix}`;
}

function lambdaDesired(context: AwsResolverContext) {
	const owner = optionalString(context.desired, "ownershipRef");
	if (owner !== undefined) {
		const allowed = new Set([
			"name",
			"image",
			"executionRoleArn",
			"memoryMb",
			"timeoutSeconds",
			"reservedConcurrency",
			"architecture",
			"ownershipRef",
			"artifactDigest",
		]);
		for (const key of Object.keys(context.desired))
			if (!allowed.has(key))
				throw new ResolverError(
					"RESOLVER_PRODUCT_UNSUPPORTED",
					`Budgeted Lambda does not implement desired.${key}; unhandled bindings cannot be silently omitted`,
				);
	}
	const artifact = optionalString(context.desired, "artifactDigest");
	if (
		context.desired.ownershipRef !== undefined &&
		(!owner || !/^sha256:[a-f0-9]{64}$/u.test(owner))
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Lambda ownershipRef must be a complete sha256 ownership identity",
		);
	if (
		(context.desired.artifactDigest !== undefined || owner !== undefined) &&
		(!artifact || !/^sha256:[a-f0-9]{64}$/u.test(artifact))
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Lambda artifactDigest must pin the complete approved sha256 artifact",
		);
	const image = optionalString(context.desired, "image");
	const role = optionalString(context.desired, "executionRoleArn");
	const imageMatch = image?.match(
		/^([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/[A-Za-z0-9._/-]+@sha256:[a-f0-9]{64}$/u,
	);
	const roleMatch = role?.match(
		/^arn:(aws|aws-us-gov):iam::([0-9]{12}):role\/[A-Za-z0-9+=,.@_/-]+$/u,
	);
	if (
		!image ||
		!imageMatch ||
		imageMatch[2] !== context.region ||
		!role ||
		!roleMatch
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Lambda requires desired.image as an immutable ECR sha256 image in the selected region and an explicit desired.executionRoleArn",
		);
	const memory = optionalInteger(context.desired, "memoryMb");
	const timeout = optionalInteger(context.desired, "timeoutSeconds");
	const architecture = optionalString(context.desired, "architecture");
	const concurrency = optionalInteger(context.desired, "reservedConcurrency");
	if (
		(owner !== undefined ||
			context.desired.reservedConcurrency !== undefined) &&
		(concurrency === undefined || concurrency < 1 || concurrency > 1_000_000)
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Budgeted Lambda requires explicit positive bounded reservedConcurrency",
		);
	if (
		memory === undefined ||
		memory < 128 ||
		memory > 10240 ||
		timeout === undefined ||
		timeout < 1 ||
		timeout > 900 ||
		!["x86_64", "arm64"].includes(architecture ?? "")
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Lambda requires bounded memoryMb (128..10240), timeoutSeconds (1..900), and architecture (x86_64 or arm64); no cost or capacity defaults are invented",
		);
	const arn = `arn:${roleMatch[1]}:lambda:${context.region}:${roleMatch[2]}:function:${context.name}`;
	if (context.knownPhysicalId !== undefined && context.knownPhysicalId !== arn)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Lambda physical identity belongs to another function or account scope",
		);
	return {
		image,
		role,
		memory,
		timeout,
		architecture,
		concurrency,
		arn,
		owner,
		artifact,
	};
}

async function readLambda(
	context: AwsResolverContext,
): Promise<JsonObject | undefined> {
	const desired = lambdaDesired(context);
	const response = await send(context, {
		service: "lambda",
		method: "GET",
		path: lambdaPath(context),
	});
	if (response.status === 404) return undefined;
	const record = jsonResult(context, response, `lambda get ${context.name}`);
	const config = answerRecord(
		record,
		"Configuration",
		`lambda get ${context.name}`,
	);
	if (
		!config ||
		config.FunctionArn !== desired.arn ||
		config.FunctionName !== context.name ||
		config.PackageType !== "Image"
	)
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			"Lambda response identity or package type differs from the approved resource scope",
		);
	if (
		desired.owner !== undefined &&
		answerRecord(record, "Tags", `lambda get ${context.name}`)?.[
			"hobo:owner"
		] !== desired.owner
	)
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			"Lambda has different or missing ownership metadata; implicit adoption is forbidden",
		);
	return record;
}

function lambdaOutputs(
	context: AwsResolverContext,
	record: JsonObject | undefined,
): JsonObject {
	const wanted = lambdaDesired(context);
	const configuration =
		record === undefined
			? undefined
			: answerRecord(record, "Configuration", `lambda get ${context.name}`);
	const code =
		record === undefined
			? undefined
			: answerRecord(record, "Code", `lambda get ${context.name}`);
	const observedImage = code?.ResolvedImageUri ?? code?.ImageUri;
	const architectures = configuration?.Architectures;
	const configurationMatches =
		configuration !== undefined &&
		configuration.Role === wanted.role &&
		configuration.MemorySize === wanted.memory &&
		configuration.Timeout === wanted.timeout &&
		isJsonArray(architectures) &&
		architectures.length === 1 &&
		architectures[0] === wanted.architecture;
	const state =
		configuration === undefined
			? undefined
			: optionalString(configuration, "State");
	const update =
		configuration === undefined
			? undefined
			: optionalString(configuration, "LastUpdateStatus");
	const terminal =
		configuration !== undefined &&
		((state === "Active" && update === "Successful") ||
			state === "Failed" ||
			update === "Failed");
	const ready =
		wanted.owner !== undefined &&
		wanted.artifact !== undefined &&
		(record === undefined
			? undefined
			: answerRecord(record, "Tags", `lambda get ${context.name}`)?.[
					"hobo:artifact"
				]) === wanted.artifact &&
		terminal &&
		state === "Active" &&
		update === "Successful" &&
		observedImage === wanted.image &&
		configurationMatches &&
		(wanted.concurrency === undefined ||
			(record !== undefined &&
				answerRecord(record, "Concurrency", `lambda get ${context.name}`)
					?.ReservedConcurrentExecutions === wanted.concurrency));
	const outputs: JsonObject = {
		functionArn: wanted.arn,
		functionName: context.name,
		ready,
		operationConfirmed: terminal,
		lifecycleStatus: ready
			? "ready"
			: state === "Failed" || update === "Failed"
				? "failed"
				: "pending",
	};
	if (isJsonString(observedImage))
		Object.assign(outputs, { image: observedImage });
	const contentDigest = isJsonString(observedImage)
		? observedImage.match(/@(sha256:[a-f0-9]{64})$/u)?.[1]
		: undefined;
	if (contentDigest !== undefined)
		Object.assign(outputs, { artifactDigest: contentDigest });
	if (configuration?.RevisionId !== undefined)
		Object.assign(outputs, { revisionId: configuration.RevisionId });
	const nativeArtifact =
		record === undefined
			? undefined
			: answerRecord(record, "Tags", `lambda get ${context.name}`)?.[
					"hobo:artifact"
				];
	if (isJsonString(nativeArtifact))
		Object.assign(outputs, { artifactMarker: nativeArtifact });
	return outputs;
}

const LAMBDA_SPEC: Omit<AwsResolverSpec, "productId"> = {
	settings: {
		image: "string",
		executionRoleArn: "string",
		memoryMb: "integer",
		timeoutSeconds: "integer",
		reservedConcurrency: "integer",
		architecture: "string",
		ownershipRef: "string",
		artifactDigest: "string",
	},
	async read(context) {
		const record = await readLambda(context);
		return record === undefined
			? undefined
			: outcome(
					settledAction(context),
					lambdaDesired(context).arn,
					lambdaOutputs(context, record),
					[],
				);
	},
	async reconcile(context) {
		const wanted = lambdaDesired(context);
		const observed = await readLambda(context);
		if (observed !== undefined) {
			if (
				wanted.artifact !== undefined &&
				answerRecord(observed, "Tags", `lambda get ${context.name}`)?.[
					"hobo:artifact"
				] !== wanted.artifact
			)
				throw new ResolverError(
					"RESOLVER_PRODUCT_UNSUPPORTED",
					"Lambda artifact differs; use a new immutable target function rather than overwriting an older deployment",
				);
			const outputs = lambdaOutputs(context, observed);
			if (outputs.ready === true || outputs.operationConfirmed !== true)
				return outcome(settledAction(context), wanted.arn, outputs, []);
			const config = answerRecord(
				observed,
				"Configuration",
				`lambda get ${context.name}`,
			);
			const revision =
				config === undefined ? undefined : optionalString(config, "RevisionId");
			if (!revision)
				throw new ResolverError(
					"RESOLVER_OUTPUT_UNPARSEABLE",
					"Lambda has no revision fence for an update",
				);
			const code = answerRecord(observed, "Code", `lambda get ${context.name}`);
			const imageChanged =
				(code?.ResolvedImageUri ?? code?.ImageUri) !== wanted.image;
			const architectures = config?.Architectures;
			const configChanged =
				config?.Role !== wanted.role ||
				config?.MemorySize !== wanted.memory ||
				config?.Timeout !== wanted.timeout ||
				!isJsonArray(architectures) ||
				architectures.length !== 1 ||
				architectures[0] !== wanted.architecture;
			const concurrencyChanged =
				wanted.concurrency !== undefined &&
				answerRecord(observed, "Concurrency", `lambda get ${context.name}`)
					?.ReservedConcurrentExecutions !== wanted.concurrency;
			if (
				[imageChanged, configChanged, concurrencyChanged].filter(Boolean)
					.length > 1
			)
				throw new ResolverError(
					"RESOLVER_PRODUCT_UNSUPPORTED",
					"Lambda image and capacity changes require a new immutable target function; two unjournaled mutations cannot share one execution claim",
				);
			if (!imageChanged && !configChanged && !concurrencyChanged)
				return outcome(settledAction(context), wanted.arn, outputs, [
					"provider initialization is not ready; unchanged configuration is not rewritten",
				]);
			if (concurrencyChanged) {
				await setLambdaConcurrency(context, wanted.concurrency);
				return outcome(
					"update",
					wanted.arn,
					lambdaOutputs(context, await readLambda(context)),
					[],
				);
			}
			const response = await send(context, {
				service: "lambda",
				method: "PUT",
				path: lambdaPath(context, imageChanged ? "/code" : "/configuration"),
				headers: { "content-type": "application/json" },
				body: JSON.stringify(
					imageChanged
						? {
								ImageUri: wanted.image,
								Architectures: [wanted.architecture],
								RevisionId: revision,
								Publish: false,
							}
						: {
								Role: wanted.role,
								MemorySize: wanted.memory,
								Timeout: wanted.timeout,
								RevisionId: revision,
							},
				),
			});
			jsonResult(context, response, `lambda update ${context.name}`);
			const updated = await readLambda(context);
			return outcome(
				"update",
				wanted.arn,
				lambdaOutputs(context, updated),
				updated === undefined
					? [
							"Lambda update acknowledged but resource is absent; outcome remains unconfirmed",
						]
					: [],
			);
		}
		const body = {
			FunctionName: context.name,
			PackageType: "Image",
			Role: wanted.role,
			Code: { ImageUri: wanted.image },
			MemorySize: wanted.memory,
			Timeout: wanted.timeout,
			Architectures: [wanted.architecture],
			Publish: false,
		};
		if (wanted.owner !== undefined)
			Object.assign(body, {
				Tags: { "hobo:owner": wanted.owner, "hobo:artifact": wanted.artifact },
			});
		const response = await send(context, {
			service: "lambda",
			method: "POST",
			path: "/2015-03-31/functions",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (response.status !== 409)
			jsonResult(context, response, `lambda create ${context.name}`);
		if (response.status !== 409 && wanted.concurrency !== undefined)
			await setLambdaConcurrency(context, wanted.concurrency);
		const created = await readLambda(context);
		if (response.status === 409 && created === undefined)
			throw new ResolverError(
				"RESOLVER_PROVIDER_REJECTED",
				"Lambda create conflicted but no scoped function can be observed; outcome is unknown",
			);
		return outcome(
			response.status === 409 ? "adopt" : "create",
			wanted.arn,
			lambdaOutputs(context, created),
			created === undefined
				? [
						"Lambda create acknowledged but resource is absent; outcome remains unconfirmed",
					]
				: [],
		);
	},
	async remove(context) {
		const desired = lambdaDesired(context);
		const existing = await readLambda(context);
		if (existing === undefined) return;
		if (
			desired.artifact !== undefined &&
			answerRecord(existing, "Tags", `lambda get ${context.name}`)?.[
				"hobo:artifact"
			] !== desired.artifact
		)
			throw new ResolverError(
				"RESOLVER_PROVIDER_REJECTED",
				"Lambda retirement artifact no longer matches the approved source",
			);
		const response = await send(context, {
			service: "lambda",
			method: "DELETE",
			path: lambdaPath(context),
		});
		if (response.status === 404) return;
		if (!isSuccess(response))
			rejectJson(context, response, `lambda delete ${context.name}`);
		if ((await readLambda(context)) !== undefined)
			throw new ResolverError(
				"RESOLVER_PROVIDER_REJECTED",
				"Lambda still exists after deletion; retirement is not confirmed",
			);
	},
};

async function setLambdaConcurrency(
	context: AwsResolverContext,
	quantity: number | undefined,
): Promise<void> {
	if (quantity === undefined)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Lambda reserved concurrency is not bounded",
		);
	const response = await send(context, {
		service: "lambda",
		method: "PUT",
		path: `/2017-10-31/functions/${encodeComponent(context.name)}/concurrency`,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ReservedConcurrentExecutions: quantity }),
	});
	jsonResult(context, response, `lambda concurrency ${context.name}`);
}

// ---------------------------------------------------------------------------
// Wrapper and registry
// ---------------------------------------------------------------------------

/** Per-product behaviour; the wrapper owns credentials, naming, and refusals. */
interface AwsResolverSpec {
	readonly productId: string;
	/**
	 * The declared parameters this product reads as directives, not state.
	 * Every AWS directive is a boolean flag, parsed by {@link parseSettings}.
	 */
	readonly directives?: readonly string[];
	/**
	 * The `desired` settings this product reads, and the JSON type each must
	 * have; `name` is common to every product. {@link parseSettings} checks them
	 * before any call, so a wrong type is refused rather than read as absent.
	 */
	readonly settings?: Readonly<Record<string, DesiredType>>;
	reconcile(context: AwsResolverContext): Promise<ResolveOutcome>;
	read(context: AwsResolverContext): Promise<ResolveOutcome | undefined>;
	remove(context: AwsResolverContext): Promise<void>;
}

/** The JSON type a product's `desired` setting must have. */
type DesiredType = "boolean" | "integer" | "string";

/** How a refusal names each type. */
const DESIRED_TYPE_NAMES = {
	boolean: "a boolean (true or false)",
	integer: "an integer",
	string: "a string",
} as const satisfies Readonly<Record<DesiredType, string>>;

/** The setting every product reads: the resource name. */
const COMMON_SETTINGS = {
	name: "string",
} as const satisfies Readonly<Record<string, DesiredType>>;

function hasDesiredType(value: JsonValue, type: DesiredType): boolean {
	switch (type) {
		case "boolean":
			return isJsonBoolean(value);
		case "integer":
			return isJsonNumber(value) && Number.isSafeInteger(value);
		case "string":
			return isJsonString(value);
	}
}

/**
 * The parse boundary for a product's typed `desired` settings, run before
 * credentials are resolved or any call is made. A setting that is absent stays
 * absent. A setting present with any other type, `null` included, is refused
 * with RESOLVER_PRODUCT_UNSUPPORTED in the words every wrong-type setting gets
 * ("<id>: desired.<key> must be a boolean (true or false), received …"). Read
 * loosely, `versioning: "true"` would be "not declared" and the bucket left as
 * it is, and `forceDelete: "true"` would preview clean and then delete without
 * force. The resolvers can read these settings with the optional readers
 * because their types were checked here. Directives are boolean settings too,
 * and the set returned is the directives the declaration switches on.
 */
function parseSettings(
	desired: JsonObject,
	settings: Readonly<Record<string, DesiredType>>,
	directives: readonly string[],
	productId: string,
): ReadonlySet<string> {
	const declared: [string, DesiredType][] = [
		...Object.entries(settings),
		...directives.map((name): [string, DesiredType] => [name, "boolean"]),
	];
	for (const [key, type] of declared) {
		if (!Object.hasOwn(desired, key)) continue;
		const value = desired[key];
		if (value === undefined || !hasDesiredType(value, type)) {
			// A `desired` setting of the wrong type is RESOLVER_PRODUCT_UNSUPPORTED,
			// in the same words as every other one this file refuses.
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`${productId}: desired.${key} must be ${DESIRED_TYPE_NAMES[type]}, received ${redactAwsText(JSON.stringify(value), undefined, 80)}`,
				productId,
			);
		}
	}
	return new Set(directives.filter((name) => desired[name] === true));
}

function clockOf(nowMs: AwsResolverOptions["nowMs"]): () => number {
	if (nowMs === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"aws resolvers need an injected nowMs (a number or a () => number). SigV4 signs a timestamp, and reading the clock inside the resolver would make a signed request untestable",
		);
	}
	if (nowMs instanceof Function) return nowMs;
	if (Number.isFinite(nowMs)) return () => nowMs;
	throw new ResolverError(
		"RESOLVER_PRODUCT_UNSUPPORTED",
		"aws resolvers need an injected nowMs (a number or a () => number). SigV4 signs a timestamp, and reading the clock inside the resolver would make a signed request untestable",
	);
}

function createResolver(
	spec: AwsResolverSpec,
	options: AwsResolverOptions,
): ResourceResolver {
	const region = parseAwsRegion(options.region);
	const nowMs = clockOf(options.nowMs);
	if (options.resolveCredential === undefined) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			"aws resolvers need an injected resolveCredential(ref): the resolver never reads an environment variable or a credential file itself",
		);
	}

	async function contextFor(
		input: ResolveRequest,
		transport: HttpTransport,
	): Promise<AwsResolverContext> {
		const request = parseResolveRequest(parseJsonObject(JSON.stringify(input)));
		if (request.ref.productId !== spec.productId) {
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`aws resolver for ${spec.productId} was handed a request for ${JSON.stringify(request.ref.productId)}; route the request through the registry rather than picking a resolver by hand`,
				spec.productId,
			);
		}
		const desired = parseJsonObject(JSON.stringify(request.desired));
		const directivesOn = parseSettings(
			desired,
			{ ...COMMON_SETTINGS, ...spec.settings },
			spec.directives ?? [],
			spec.productId,
		);
		const credentials = await resolveAwsCredentials(
			request,
			options.resolveCredential,
		);
		return {
			request,
			transport: guardedAwsTransport(transport, region),
			credentials,
			region,
			nowMs,
			name: resourceName(request, spec.productId),
			desired,
			knownPhysicalId: knownPhysicalId(request),
			directivesOn,
			redact(text: string, limit = 400): string {
				return redactAwsText(text, credentials, limit);
			},
		};
	}

	return {
		providerId: AWS_PROVIDER_TARGET,
		productId: spec.productId,
		...(spec.directives === undefined
			? undefined
			: { directives: spec.directives }),
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
 * Every AWS resolver, id-sorted so the list is a function of the code rather
 * than of construction order. Products named in
 * {@link AWS_UNRESOLVED_PRODUCT_IDS} are deliberately absent.
 */
export function awsResolvers(
	options: AwsResolverOptions,
): readonly ResourceResolver[] {
	const specs: readonly AwsResolverSpec[] = [
		{ productId: AWS_DYNAMODB_PRODUCT_ID, ...DYNAMODB_SPEC },
		{ productId: AWS_LAMBDA_PRODUCT_ID, ...LAMBDA_SPEC },
		{ productId: AWS_S3_PRODUCT_ID, ...S3_SPEC },
		{ productId: AWS_SECRETS_MANAGER_PRODUCT_ID, ...SECRETS_MANAGER_SPEC },
		{ productId: AWS_SNS_PRODUCT_ID, ...SNS_SPEC },
		{
			productId: AWS_SQS_FIFO_PRODUCT_ID,
			...sqsSpec(AWS_SQS_FIFO_PRODUCT_ID),
		},
		{ productId: AWS_SQS_PRODUCT_ID, ...sqsSpec(AWS_SQS_PRODUCT_ID) },
		{ productId: AWS_SSM_PARAMETER_PRODUCT_ID, ...SSM_PARAMETER_SPEC },
	];
	return Object.freeze(
		[...specs]
			.sort((left, right) => compareStrings(left.productId, right.productId))
			.map((spec) => createResolver(spec, options)),
	);
}

/** The same resolvers, behind core's product-id lookup. */
export function awsResolverRegistry(options: AwsResolverOptions): {
	get(productId: string): ResourceResolver | undefined;
	list(): readonly ResourceResolver[];
} {
	return createResolverRegistry(awsResolvers(options));
}
