import {
	CLOUD_EVENTS,
	collectStream,
	type DeploymentPlan,
	type IacDiff,
	type IacDriftReport,
	type IacOutputs,
	type IacProgram,
	type IacProvider,
	type ResourcePlan,
} from "@hobo/cloud";
import {
	CAPABILITY_SLOTS,
	type CapabilitySlot,
	createBoundedFetchTransport,
	type EventEnvelope,
	type EventStore,
	type HttpTransport,
	parseResolveOutcome,
	parseResolveRequest,
	parseResolverDirectives,
	RESOLVER_CONTRACT,
	type ResolveOutcome,
	type ResolveRequest,
	type ResourceResolver,
} from "@hobo/core";
import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

// ---------------------------------------------------------------------------
// The direct-HTTP resolver plane, behind the kernel's `IacProvider` port.
//
// `@hobo/cloud`'s Executor drives an injected `IacProvider`. Until now that port
// could only be served by an IaC engine (`createPulumiBackedIacProvider`) or by
// one of the two bespoke deploy providers. The resolver plane
// (`@hobo/core`'s `hobo.resource-resolver/v1`) stood beside that path rather
// than behind it: `cloudflareResolverRegistry()` and `vercelResolverRegistry()`
// were reachable from a test and from nothing else. This module closes that.
//
// The shape mirrors `pulumi-iac-provider.ts` exactly, because the hard problem
// is the same one: `IacProgram` is a thin EXECUTION descriptor
// (programId/deploymentId/resourceId/provider/driver/action/stackName) that
// identifies a resource and carries no desired state. Desired state is recovered
// from the durable `deployment.Planned` fact already on the deployment stream —
// the same content-addressed plan the gateway stored — and never fabricated:
//
//   1. read the stored `DeploymentPlan` for `program.deploymentId`,
//   2. find this resource's real `ResourcePlan` by `program.resourceId`,
//   3. key the resolver lookup on the plan node's `productId` (ADR-0157) and
//      use its `realizationParameters` as `ResolveRequest.desired`,
//   4. call the REAL resolver's `reconcile`/`delete`/`read` over the injected,
//      already-guarded `HttpTransport`.
//
// FAIL CLOSED ON AN UNDECIDED PRODUCT. `productId` and `realizationParameters`
// are populated only when the plan was built with Yard binding authority. On the
// legacy port-only planning path they are ABSENT, and absent means "not decided
// here" — never "any product will do". A node without a `productId` is refused
// with a typed code that names the remediation; the product is NEVER guessed
// from the port or the provider id, which is exactly the naming-convention
// inference ADR-0144 forbids.
//
// PREVIEW NEVER LIES. `IacDiff.changes` is a bare count with no "unknown", so a
// preview that could not look reports {@link RESOLVER_PREVIEW_UNDETERMINED} and
// says so in the summary rather than reporting `0`. A silent "0 changes" from a
// driver that never inspected anything is the single worst failure mode here:
// it reads exactly like a verified no-op.
//
// NO CREDENTIAL MATERIAL. `credentialRef` is a LOCATOR (`scheme://path`); the
// host resolves it to material at call time inside the resolver. Nothing in this
// module holds, logs, or echoes a secret, and nothing here reaches for a global
// `fetch` — the transport is injected. Provider error text is redacted by the
// resolvers themselves (`redactCloudflareText` and the Vercel equivalent), so
// this module re-raises rather than re-implementing redaction.
//
// DETERMINISM: no clock, no randomness, no ambient environment reads in the
// logic below. `createFetchHttpTransport` is the one I/O adapter and is opt-in.
//
// HONEST SCOPE: everything here is proven against an INJECTED FAKE transport.
// This module has never issued a live provider call; a real deploy additionally
// needs real credentials, real network egress, and a real provider account, none
// of which a unit test supplies.
// ---------------------------------------------------------------------------

// public-contract: every refusal this deploy driver can report, so a caller can branch on the reason rather than matching on a message.
export const RESOLVER_IAC_ERROR_CODES = Object.freeze([
	"RESOLVER_IAC_PLAN_MISSING",
	"RESOLVER_IAC_RESOURCE_UNPLANNED",
	"RESOLVER_IAC_PRODUCT_UNDECIDED",
	"RESOLVER_IAC_SLOT_UNDECIDED",
	"RESOLVER_IAC_PRODUCT_UNREGISTERED",
	"RESOLVER_IAC_OUTPUT_RESERVED_KEY",
] as const);
export type ResolverIacErrorCode = (typeof RESOLVER_IAC_ERROR_CODES)[number];

/**
 * Refusal from the resolver-backed deploy driver. Always carries a `code` and a
 * `remediation` naming what to change — a refusal an operator cannot act on is
 * an outage with extra steps.
 */
export class ResolverIacError extends Error {
	readonly code: ResolverIacErrorCode;
	readonly resourceId: string;
	readonly remediation: string;

	constructor(
		code: ResolverIacErrorCode,
		resourceId: string,
		problem: string,
		remediation: string,
	) {
		super(`${resourceId}: ${problem}. ${remediation}`);
		this.name = "ResolverIacError";
		this.code = code;
		this.resourceId = resourceId;
		this.remediation = remediation;
	}
}

/**
 * The change count a preview reports when it could not determine one. `IacDiff`
 * models changes as a plain number with no "unknown", and `0` is a claim — "I
 * looked and nothing will change" — that a driver without a `read()` has no
 * evidence for. A negative sentinel cannot be mistaken for a verified count.
 */
export const RESOLVER_PREVIEW_UNDETERMINED = -1;

/** Core's resolver registry, structurally: the lookup this driver routes on. */
export interface ResolverIacRegistry {
	get(productId: string): ResourceResolver | undefined;
	list(): readonly ResourceResolver[];
}

export interface ResolverBackedIacProviderOptions {
	/** The durable store the Orchestrator wrote `deployment.Planned` to. */
	readonly store: EventStore;
	/** Resolvers keyed by product id (e.g. `cloudflareResolverRegistry(...)`). */
	readonly registry: ResolverIacRegistry;
	/**
	 * The credentialed HTTPS boundary, already wrapped in the provider's
	 * `guardTransport` policy by the host. Injected: this module never reaches
	 * for a global `fetch`, so a bad config value cannot point a credentialed
	 * request at an attacker's origin without the host having chosen it.
	 */
	readonly transport: HttpTransport;
	/**
	 * The credential LOCATOR (`scheme://path`) the resolvers hand back to the
	 * host to resolve at call time. Never material: a token here is a token in
	 * the event log, and `parseResolveRequest` refuses anything value-shaped.
	 */
	readonly credentialRef: string;
}

/**
 * Reserved `IacOutputs` namespace. The resolver's own outputs are published
 * under their own keys; the outcome's metadata (action, physical id, contract,
 * diagnostics) lands under this prefix so an operator can read what the resolver
 * decided and not only what it returned. A resolver output that would collide is
 * refused rather than shadowed — silently overwriting a provider fact with
 * driver metadata is a lie about the resource.
 */
const RESERVED_OUTPUT_PREFIX = "hobo.resolver.";

/**
 * Plan capability port -> capability slot.
 *
 * `ResolvedResourceRef.slot` is required by `parseResolveRequest`, and a plan
 * node carries a capability PORT rather than a slot. The port *is* the
 * capability class, so this table is a restatement of a vocabulary, not an
 * inference about which product to build: identity for every slot name, plus the
 * two aliases HoBo's own lowering emits (`compute`, `objectStore`). A port
 * outside the table is refused, never defaulted — the wrong slot binds a
 * capability the app never asked for.
 */
const SLOT_BY_PLAN_PORT: ReadonlyMap<string, CapabilitySlot> = new Map<
	string,
	CapabilitySlot
>([
	...CAPABILITY_SLOTS.map((slot): readonly [string, CapabilitySlot] => [
		slot,
		slot,
	]),
	["compute", "service"],
	["objectStore", "bucket"],
]);

function planFromStream(
	events: readonly EventEnvelope[],
): DeploymentPlan | undefined {
	let plan: DeploymentPlan | undefined;
	for (const event of events) {
		if (event.type === CLOUD_EVENTS.DeploymentPlanned) {
			// SAFETY: assertion required at this I/O or test boundary.
			plan = (event.data as { plan: DeploymentPlan }).plan;
		}
	}
	return plan;
}

/** Code-unit comparison: locale-independent, so ordering is reproducible. */
function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * `IacOutputs` is `Record<string, string>`, but a resolver's outputs bag is
 * JSON — numbers, booleans, nulls, arrays, nested objects. Dropping the
 * non-strings would silently lose provider facts, so they are JSON-encoded
 * instead. The encoding is deterministic because `parseResolveOutcome` has
 * already sorted every property key by code unit, so the same outcome always
 * produces the same bytes. A string passes through verbatim, so `eu-west` never
 * becomes `"eu-west"` with quotes baked in.
 */
function stringifyOutput(value: JsonValue | undefined): string {
	if (isJsonString(value)) return value;
	const encoded = JSON.stringify(value);
	return encoded === undefined ? "null" : encoded;
}

function toIacOutputs(outcome: ResolveOutcome, resourceId: string): IacOutputs {
	const outputs: IacOutputs = {};
	for (const key of Object.keys(outcome.outputs).sort(compareStrings)) {
		if (key.startsWith(RESERVED_OUTPUT_PREFIX)) {
			throw new ResolverIacError(
				"RESOLVER_IAC_OUTPUT_RESERVED_KEY",
				resourceId,
				`the resolver returned an output named ${JSON.stringify(key)}, which is inside the ${JSON.stringify(RESERVED_OUTPUT_PREFIX)} namespace this driver publishes its own outcome metadata under`,
				`Rename the provider output: publishing it would either shadow the driver's metadata or be shadowed by it, and a silently overwritten output is a lie about what the provider reported`,
			);
		}
		outputs[key] = stringifyOutput(cloneAsJson(outcome.outputs[key]));
	}
	outputs[`${RESERVED_OUTPUT_PREFIX}contract`] = outcome.contract;
	outputs[`${RESERVED_OUTPUT_PREFIX}action`] = outcome.action;
	outputs[`${RESERVED_OUTPUT_PREFIX}physicalId`] = outcome.physicalId;
	// Diagnostics are surfaced, never swallowed: a diagnostic the resolver
	// bothered to emit ("ttlSeconds is declared but not applied", "bucket
	// location is immutable") is the one place an operator learns that what was
	// asked for is not what exists.
	if (outcome.diagnostics.length > 0) {
		outputs[`${RESERVED_OUTPUT_PREFIX}diagnostics`] = JSON.stringify(
			outcome.diagnostics,
		);
	}
	return outputs;
}

/** What can and cannot be said about desired-vs-observed for one resource. */
interface DesiredComparison {
	/** Declared parameters the provider reports with a different value. */
	readonly differing: readonly string[];
	/** Declared parameters `read()` reports nothing about, either way. */
	readonly unobservable: readonly string[];
	/** Declared directives `read()` reports nothing about, left out. */
	readonly directives: readonly string[];
}

/**
 * Compare the declared realization parameters against what `read()` reported.
 *
 * Only keys present in BOTH bags can be compared; a provider's read surface
 * names things its own way (`namespaceId`, `bucketName`) and a declared
 * parameter with no counterpart is genuinely unknown, not "matching". So the
 * comparison reports both sets and lets the caller phrase the honest verdict:
 * a difference is a lower bound on the change count, and an unobservable
 * parameter makes the total undetermined.
 *
 * A key the resolver names in `directives` says how apply or delete acts
 * (`restoreScheduled`, `forceDelete`), not what the resource is, so `read()`
 * normally reports nothing for it. Such a key is left out rather than counted
 * as unobservable, and listed so the verdict can say what it did not compare
 * (ADR-0175). A directive key `read()` DOES report is compared like any other
 * parameter: the list only excuses a key there is nothing to compare against,
 * so naming a reported state key as a directive cannot hide its drift.
 */
function compareDesired(
	desired: JsonObject,
	observed: JsonObject,
	directiveKeys: readonly string[],
): DesiredComparison {
	const differing: string[] = [];
	const unobservable: string[] = [];
	const directives: string[] = [];
	const isDirective = new Set(directiveKeys);
	// Keys are already code-unit sorted by the parse boundaries; sorting again
	// keeps the result stable if that ever stops being true.
	for (const key of Object.keys(desired).sort(compareStrings)) {
		if (!Object.hasOwn(observed, key)) {
			(isDirective.has(key) ? directives : unobservable).push(key);
			continue;
		}
		if (stringifyOutput(desired[key]) !== stringifyOutput(observed[key])) {
			differing.push(key);
		}
	}
	return { differing, unobservable, directives };
}

/**
 * The verdict when nothing compared differs. With directives left out it says
 * "every compared declared parameter", never "every declared parameter": the
 * directives were declared and not compared.
 */
function allMatch(directives: readonly string[]): string {
	return `every ${directives.length === 0 ? "" : "compared "}declared parameter matches what the provider reports`;
}

/** Names the declared directives a comparison left out, or nothing. */
function directiveNote(directives: readonly string[]): string {
	if (directives.length === 0) return "";
	const kind =
		directives.length === 1
			? "a directive that says how apply or delete acts, not state"
			: "directives that say how apply or delete acts, not state";
	return ` Not compared: ${directives.join(", ")} (${kind}).`;
}

function diagnosticSuffix(diagnostics: readonly string[]): string {
	return diagnostics.length === 0
		? ""
		: ` Diagnostics: ${diagnostics.join("; ")}`;
}

/** One resource, resolved from the stored plan and routed to its resolver. */
interface BoundResource {
	readonly plan: ResourcePlan;
	readonly productId: string;
	readonly resolver: ResourceResolver;
	/** The resolver's directives, parsed (a frozen copy, refused if malformed). */
	readonly directives: readonly string[];
	readonly request: ResolveRequest;
}

export function createResolverBackedIacProvider(
	options: ResolverBackedIacProviderOptions,
): IacProvider {
	const { store, registry, transport, credentialRef } = options;

	/**
	 * Recover this resource's desired state from the durable plan and route it
	 * to the resolver that can allocate it. Every branch below fails closed with
	 * a typed code: unlike the Pulumi bridge, this driver talks to a real
	 * provider account, so "could not work out what to do" must never degrade
	 * into a silent no-op that reads as success.
	 */
	async function bind(program: IacProgram): Promise<BoundResource> {
		const events = await collectStream(
			store,
			`deployment:${program.deploymentId}`,
		);
		const plan = planFromStream(events);
		if (plan === undefined) {
			throw new ResolverIacError(
				"RESOLVER_IAC_PLAN_MISSING",
				program.resourceId,
				`stream deployment:${program.deploymentId} carries no deployment.Planned fact, so there is no stored plan to recover desired state from`,
				"Run the plan step against the SAME event store before up/down; this driver reads the content-addressed plan the gateway stored and never fabricates one",
			);
		}
		const resource = plan.resources.find(
			(candidate) => candidate.name === program.resourceId,
		);
		if (resource === undefined) {
			throw new ResolverIacError(
				"RESOLVER_IAC_RESOURCE_UNPLANNED",
				program.resourceId,
				`the stored plan for ${program.deploymentId} has no resource by that name (it plans ${plan.resources.map((entry) => entry.name).join(", ") || "nothing"})`,
				"Re-plan the deployment so the resource being executed is one the stored plan actually contains",
			);
		}
		const { productId } = resource;
		if (productId === undefined) {
			throw new ResolverIacError(
				"RESOLVER_IAC_PRODUCT_UNDECIDED",
				program.resourceId,
				`the stored plan node names no productId, so no resolver can be keyed to it (port ${JSON.stringify(resource.port)}, provider ${JSON.stringify(resource.provider)})`,
				"Plan this deployment with Yard binding authority — a Yard whose rows bind this resource's capability profile — so the plan node carries productId (ADR-0157). An absent productId means the product was NOT decided, never that any product will do, and this driver will not infer one from the port or the provider id (ADR-0144)",
			);
		}
		const slot = SLOT_BY_PLAN_PORT.get(resource.port);
		if (slot === undefined) {
			throw new ResolverIacError(
				"RESOLVER_IAC_SLOT_UNDECIDED",
				program.resourceId,
				`the stored plan node's capability port ${JSON.stringify(resource.port)} is outside the capability-slot vocabulary (${CAPABILITY_SLOTS.join(", ")})`,
				"Author the resource against a capability port this vocabulary covers; the slot is never defaulted, because the wrong slot binds a capability the app never asked for",
			);
		}
		const resolver = registry.get(productId);
		if (resolver === undefined) {
			const known = registry
				.list()
				.map((entry) => entry.productId)
				.sort(compareStrings);
			throw new ResolverIacError(
				"RESOLVER_IAC_PRODUCT_UNREGISTERED",
				program.resourceId,
				`no resolver is registered for product ${JSON.stringify(productId)}`,
				`Register a resolver for ${JSON.stringify(productId)}, or bind this resource to a product one of the registered resolvers covers (${known.join(", ") || "none registered"})`,
			);
		}
		// `parseResolveRequest` is the parse boundary: it screens the desired bag
		// for credential-shaped keys and refuses a credentialRef that is material
		// rather than a locator, before any of it reaches a provider call or a log.
		//
		// `logicalId` is the plan resource's own name — the stable author-facing
		// id a redeploy reconciles against. `physicalId` is deliberately NOT
		// threaded: this driver holds no state, so convergence rests on the
		// resolver's own deterministic-name lookup. The visible consequence is
		// that a re-apply reports `adopt` rather than `noop`, which is the honest
		// reading — this run did not create the resource and did not know its id.
		// `cloneAsJson` is the way into a parse boundary that takes untrusted
		// JSON while this caller has already assembled the domain shape: same
		// value, viewed as the JSON the parser is written against.
		const request = parseResolveRequest(
			cloneAsJson({
				ref: { slot, productId, logicalId: resource.name },
				desired: resource.realizationParameters ?? {},
				credentialRef,
			}),
		);
		// The registry is structural, so it may not be core's: the directive list
		// is parsed here as well, and a malformed one is a typed refusal.
		const directives = parseResolverDirectives(resolver);
		return { plan: resource, productId, resolver, directives, request };
	}

	return {
		id: `resolver-backed:${RESOLVER_CONTRACT}`,

		/**
		 * READ-ONLY. The only resolver method reached here is the optional
		 * `read()`; `reconcile`/`delete` are never called on this path, so a
		 * preview cannot mutate the account no matter what the plan says.
		 */
		async preview(program: IacProgram): Promise<IacDiff> {
			const bound = await bind(program);
			const label = `${program.resourceId} (${bound.productId})`;
			if (bound.resolver.read === undefined) {
				return {
					summary: `${label}: UNDETERMINED — this resolver implements no read(), so nothing was inspected and no change count can be reported. This is not "no changes"; the resource was never looked at.`,
					changes: RESOLVER_PREVIEW_UNDETERMINED,
				};
			}
			const raw = await bound.resolver.read(bound.request, transport);
			if (raw === undefined) {
				return {
					summary: `${label}: absent at the provider; apply would create it.`,
					changes: 1,
				};
			}
			// `cloneAsJson` is the way back through a parse boundary that takes
			// untrusted JSON while the port hands us the domain type: same value,
			// viewed as the JSON the parser is written against.
			const observed = parseResolveOutcome(cloneAsJson(raw));
			const diagnostics = diagnosticSuffix(observed.diagnostics);
			// A read reporting `delete` is a resource the provider is deleting
			// (a secret in its recovery window): it exists, so apply does not
			// create it, and it is not converged; the resolver's diagnostic says
			// what apply will do with it.
			if (observed.action === "delete") {
				return {
					summary: `${label}: exists as ${observed.physicalId}, and the provider is deleting it.${diagnostics}`,
					changes: 1,
				};
			}
			const desiredJson = cloneAsJson(bound.request.desired);
			const observedJson = cloneAsJson(observed.outputs);
			const { differing, unobservable, directives } = compareDesired(
				isJsonObject(desiredJson) ? desiredJson : {},
				isJsonObject(observedJson) ? observedJson : {},
				bound.directives,
			);
			const notCompared = directiveNote(directives);
			if (differing.length > 0) {
				const bound_note =
					unobservable.length > 0
						? ` A further ${unobservable.length} declared parameter(s) (${unobservable.join(", ")}) have no counterpart in what read() reports, so this count is a LOWER BOUND.`
						: "";
				return {
					summary: `${label}: exists as ${observed.physicalId}; ${differing.length} declared parameter(s) differ (${differing.join(", ")}).${bound_note}${notCompared}${diagnostics}`,
					changes: differing.length,
				};
			}
			if (unobservable.length > 0) {
				return {
					summary: `${label}: exists as ${observed.physicalId}; every observable declared parameter matches, but ${unobservable.length} (${unobservable.join(", ")}) have no counterpart in what read() reports, so whether apply would change anything is UNDETERMINED.${notCompared}${diagnostics}`,
					changes: RESOLVER_PREVIEW_UNDETERMINED,
				};
			}
			return {
				summary: `${label}: exists as ${observed.physicalId}; ${allMatch(directives)}.${notCompared}${diagnostics}`,
				changes: 0,
			};
		},

		async apply(program: IacProgram): Promise<IacOutputs> {
			const bound = await bind(program);
			// `parseResolveOutcome` is the parse boundary on the way back: a
			// provider driver is the least trusted code on the deploy path because
			// its shape follows a remote API's response.
			// `cloneAsJson` is the way back through a parse boundary that takes
			// untrusted JSON while the port hands us the domain type: same value,
			// viewed as the JSON the parser is written against.
			const outcome = parseResolveOutcome(
				cloneAsJson(await bound.resolver.reconcile(bound.request, transport)),
			);
			return toIacOutputs(outcome, program.resourceId);
		},

		async destroy(program: IacProgram): Promise<void> {
			const bound = await bind(program);
			// "Already gone" is the state destroy asks for, and the resolvers
			// already treat a 404 as success. What is NOT treated as success is a
			// destroy this driver could not route: `bind` throws instead, because
			// reporting a teardown that never issued a call would leave a real,
			// billed resource behind under a green check.
			await bound.resolver.delete(bound.request, transport);
		},

		async refresh(program: IacProgram): Promise<IacDriftReport> {
			const bound = await bind(program);
			const marker = (
				determined: boolean,
				reason: string,
				extra: IacOutputs = {},
			): IacOutputs => ({
				...extra,
				[`${RESERVED_OUTPUT_PREFIX}drift.determined`]: determined
					? "true"
					: "false",
				[`${RESERVED_OUTPUT_PREFIX}drift.reason`]: reason,
			});

			if (bound.resolver.read === undefined) {
				// `IacDriftReport.drift` is a boolean with no "unknown", and
				// `drift: false` is the claim "I looked and it matches". Absent a
				// read(), the report errs toward drift and states plainly that this
				// is a refusal to certify, not an observation of divergence.
				return {
					drift: true,
					observed: marker(
						false,
						`the ${bound.productId} resolver implements no read(), so drift was never observed; reported as drift because "no evidence" must not be recorded as "no drift"`,
					),
				};
			}
			const raw = await bound.resolver.read(bound.request, transport);
			if (raw === undefined) {
				return {
					drift: true,
					observed: marker(
						true,
						"the resource the plan describes does not exist at the provider",
						{ [`${RESERVED_OUTPUT_PREFIX}exists`]: "false" },
					),
				};
			}
			// `cloneAsJson` is the way back through a parse boundary that takes
			// untrusted JSON while the port hands us the domain type: same value,
			// viewed as the JSON the parser is written against.
			const observed = parseResolveOutcome(cloneAsJson(raw));
			const outputs = toIacOutputs(observed, program.resourceId);
			if (observed.action === "delete") {
				return {
					drift: true,
					observed: marker(
						true,
						`the provider is deleting the resource the plan describes${diagnosticSuffix(observed.diagnostics)}`,
						outputs,
					),
				};
			}
			const desiredJson = cloneAsJson(bound.request.desired);
			const observedJson = cloneAsJson(observed.outputs);
			const { differing, unobservable, directives } = compareDesired(
				isJsonObject(desiredJson) ? desiredJson : {},
				isJsonObject(observedJson) ? observedJson : {},
				bound.directives,
			);
			// A reason has no closing period of its own, so a note gets one first.
			const directiveTail =
				directives.length === 0 ? "" : `.${directiveNote(directives)}`;
			const tail = `${directiveTail}${diagnosticSuffix(observed.diagnostics)}`;
			// The directives left out, for a machine reader too: a sorted JSON
			// list under the drift metadata, present only when one was left out.
			const verdictOutputs: IacOutputs =
				directives.length === 0
					? outputs
					: {
							...outputs,
							[`${RESERVED_OUTPUT_PREFIX}drift.notCompared`]:
								JSON.stringify(directives),
						};
			if (differing.length > 0) {
				return {
					drift: true,
					observed: marker(
						true,
						`declared parameters differ from what the provider reports: ${differing.join(", ")}${tail}`,
						verdictOutputs,
					),
				};
			}
			if (unobservable.length > 0) {
				return {
					drift: true,
					observed: marker(
						false,
						`every observable declared parameter matches, but ${unobservable.join(", ")} have no counterpart in what read() reports, so drift is UNDETERMINED and is reported as drift rather than certified clean${tail}`,
						verdictOutputs,
					),
				};
			}
			return {
				drift: false,
				observed: marker(
					true,
					`${allMatch(directives)}${tail}`,
					verdictOutputs,
				),
			};
		},
	};
}

/**
 * The host's HTTP adapter for the resolver plane.
 *
 * The `fetch` implementation is a REQUIRED argument rather than a default: the
 * composition root is the layer allowed to decide that a process may reach the
 * network, and a library that silently picks up `globalThis.fetch` has made that
 * decision for it. Redirects are never followed — the request headers on this
 * path carry a provider token, and a 302 is either a contract change or a
 * hijack; either way the credential must not go with it. The timeout is enforced
 * with an `AbortController` because a transport that ignores `timeoutMs` turns
 * one slow origin into a hung deploy.
 *
 * This is I/O, not logic: it reads a clock (the abort timer) where the rest of
 * this module deliberately does not.
 */
export function createFetchHttpTransport(
	fetchImpl: typeof globalThis.fetch,
): HttpTransport {
	return createBoundedFetchTransport({ fetchImpl });
}
