/**
 * GCP resolver edges — the shared plumbing under every product.
 *
 * The suite next door drives the happy shapes. This file drives the wrapper and
 * the operation machinery: credentials, the project scope, the poll budget,
 * body parsing, provider refusals, operation vocabularies, and the adopt/noop
 * distinction. Every product resolver inherits them, so a defect here is a
 * defect nine times over — and each of these paths runs exactly when something
 * has already gone wrong.
 *
 * Three properties do most of the work:
 *
 * **A running operation is never read as a finished create.** Google's
 * long-running operations come in two vocabularies — the standard LRO says
 * `done: true`, Cloud SQL says `status: "DONE"` — and anything else, *including
 * a missing `done`*, is not finished. Defaulting to "probably done" is the
 * exact failure this machinery exists to prevent: it would report a database
 * ready before it accepts a connection.
 *
 * **The poll budget is bounded and injected.** No clock and no unbounded loop.
 * A resolver that blocked a deploy for minutes would be worse than one that
 * says "accepted, not confirmed" and lets the caller decide — but it must
 * actually say so, every time, rather than staying silent.
 *
 * **An unknown outcome is refused, never assumed.** A body this code cannot
 * parse leaves the effect of the call unknown, and both ways of guessing are
 * worse than a typed refusal.
 *
 * Everything runs through an injected fake transport. No network, no
 * credential, no Google project.
 */

import type {
	HttpTransport,
	ResolveRequest,
	ResourceResolver,
	TransportResponse,
} from "@hobo/core";
import { parseResolveRequest, type ResolveOutcome } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	GCP_CLOUD_RUN_PRODUCT_ID,
	GCP_CLOUD_STORAGE_PRODUCT_ID,
	GCP_MEMORYSTORE_REDIS_PRODUCT_ID,
	GCP_PUBSUB_TOPIC_PRODUCT_ID,
	type GcpResolverOptions,
	gcpResolverRegistry,
	redactGcpText,
} from "../src/index.js";
import type { JsonObject, JsonValue } from "../src/json.js";

type Rec = JsonObject;
type ResolverProbe =
	| (() => Promise<ResolveOutcome | undefined>)
	| (() => Promise<void>);

const CREDENTIAL_REF = "env://GOOGLE_OAUTH_ACCESS_TOKEN";
/** A token-shaped OAuth2 access token. Never expected anywhere but a header. */
const TOKEN = "ya29.FakeGoogleAccessToken0123456789abcdefghijklmno";
const PROJECT_ID = "hobo-test-project";

function options(
	overrides: Partial<GcpResolverOptions> = {},
): GcpResolverOptions {
	return {
		projectId: PROJECT_ID,
		resolveCredential: async () => TOKEN,
		...overrides,
	};
}

function resolverFor(
	productId: string,
	overrides: Partial<GcpResolverOptions> = {},
): ResourceResolver {
	const resolver = gcpResolverRegistry(options(overrides)).get(productId);
	if (resolver === undefined) {
		throw new Error(`no resolver registered for ${productId}`);
	}
	return resolver;
}

function request(input: {
	readonly productId: string;
	readonly logicalId?: string;
	readonly physicalId?: string;
	readonly desired?: Rec;
	readonly credentialRef?: string;
}): ResolveRequest {
	return parseResolveRequest({
		ref: {
			slot: "topic",
			productId: input.productId,
			logicalId: input.logicalId ?? "thing",
			...(input.physicalId !== undefined
				? { physicalId: input.physicalId }
				: undefined),
		},
		desired: input.desired ?? {},
		credentialRef: input.credentialRef ?? CREDENTIAL_REF,
	});
}

function always(response: TransportResponse): HttpTransport {
	return async () => response;
}

function sequence(...responses: readonly TransportResponse[]): HttpTransport {
	let index = 0;
	return async () => {
		const next = responses[Math.min(index, responses.length - 1)];
		index += 1;
		if (next === undefined) throw new Error("the fake ran out of responses");
		return next;
	};
}

function json(status: number, payload: JsonValue): TransportResponse {
	return {
		status,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	};
}

function raw(status: number, body: string): TransportResponse {
	return { status, headers: {}, body };
}

async function codeOf(run: ResolverProbe): Promise<string> {
	try {
		await run();
	} catch (error) {
		const code =
			error instanceof Error
				? Object.getOwnPropertyDescriptor(error, "code")?.value
				: undefined;
		return Object.prototype.toString.call(code) === "[object String]"
			? String(code)
			: "NO_CODE";
	}
	return "NO_ERROR_THROWN";
}

async function messageOf(run: ResolverProbe): Promise<string> {
	try {
		await run();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "NO_ERROR_THROWN";
}

/** A Pub/Sub read — the shortest path through the wrapper. */
function readTopic(
	transport: HttpTransport,
	overrides: Partial<GcpResolverOptions> = {},
	input: Partial<Parameters<typeof request>[0]> = {},
) {
	return resolverFor(GCP_PUBSUB_TOPIC_PRODUCT_ID, overrides).read(
		request({ productId: GCP_PUBSUB_TOPIC_PRODUCT_ID, ...input }),
		transport,
	);
}

// ---------------------------------------------------------------------------

describe("redaction", () => {
	it("scrubs anything token-shaped", () => {
		expect(redactGcpText(`bearer ${TOKEN} rejected`)).not.toContain(
			"FakeGoogleAccessToken0123456789",
		);
	});

	it("leaves short words alone", () => {
		// Redacting ordinary prose makes provider errors unreadable, and an
		// unreadable error gets ignored rather than acted on.
		expect(redactGcpText("topic is full")).toBe("topic is full");
	});

	it("truncates long text with an ellipsis", () => {
		// Google echoes request context in `error.message`, and that context has
		// carried whole resource paths.
		const scrubbed = redactGcpText("ab cd ".repeat(200), 100);
		expect(scrubbed).toHaveLength(101);
		expect(scrubbed.endsWith("…")).toBe(true);
	});

	it("does not append an ellipsis to text that fits", () => {
		expect(redactGcpText("short", 100).endsWith("…")).toBe(false);
	});
});

describe("the project scope", () => {
	it("refuses an empty projectId", () => {
		// Every Google API path is project-scoped. Guessing one would target the
		// wrong project — quietly, and with a valid token.
		expect(() => gcpResolverRegistry(options({ projectId: "" }))).toThrow(
			/project-scoped/u,
		);
	});

	it("refuses a whitespace projectId", () => {
		expect(() => gcpResolverRegistry(options({ projectId: "   " }))).toThrow(
			/project-scoped/u,
		);
	});

	it("refuses a projectId that is not a string", () => {
		expect(() =>
			gcpResolverRegistry(
				options({
					// SAFETY: intentionally violating the typed host option contract to exercise its runtime parse boundary.
					projectId: undefined as never,
				}),
			),
		).toThrow(/projectId/u);
	});

	it("puts the project in the resource name it publishes", async () => {
		// The resource name is what a binding and an IAM policy both key on.
		const outcome = await readTopic(always(json(200, { name: "x" })));
		expect(outcome?.outputs.resourceName).toBe(
			`projects/${PROJECT_ID}/topics/thing`,
		);
	});
});

describe("the poll budget", () => {
	it("defaults to a small bounded number of attempts", () => {
		// Small on purpose: blocking a deploy for minutes is worse than reporting
		// "accepted, not confirmed" and letting the caller decide.
		expect(() => gcpResolverRegistry(options())).not.toThrow();
	});

	it.each([
		-1,
		101,
		1.5,
		Number.NaN,
	])("refuses an operationPoll.attempts of %s", (attempts) => {
		expect(() =>
			gcpResolverRegistry(options({ operationPoll: { attempts } })),
		).toThrow(/bounded operationPoll/u);
	});

	it("accepts zero attempts, meaning do not poll at all", () => {
		// A caller that wants to fire and check later is making a legitimate
		// choice, not a mistake.
		expect(() =>
			gcpResolverRegistry(options({ operationPoll: { attempts: 0 } })),
		).not.toThrow();
	});

	it("accepts the top of the range", () => {
		expect(() =>
			gcpResolverRegistry(options({ operationPoll: { attempts: 100 } })),
		).not.toThrow();
	});
});

describe("the credential boundary", () => {
	it("refuses an empty credentialRef", async () => {
		expect(
			await codeOf(() =>
				readTopic(always(raw(404, "")), {}, { credentialRef: "   " }),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("refuses a credentialRef that is really a token", async () => {
		// A pasted token in this field has already leaked into the event log by
		// the time anything uses it, and every request would still succeed —
		// which is what makes the leak invisible without this check.
		expect(
			await codeOf(() =>
				readTopic(always(raw(404, "")), {}, { credentialRef: TOKEN }),
			),
		).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
	});

	it("refuses a ref that is not a locator", async () => {
		expect(
			await codeOf(() =>
				readTopic(always(raw(404, "")), {}, { credentialRef: "my token" }),
			),
		).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
	});

	it("never echoes a rejected ref that contains material", async () => {
		expect(
			await messageOf(() =>
				readTopic(
					always(raw(404, "")),
					{},
					{
						credentialRef: `oops ${TOKEN}`,
					},
				),
			),
		).not.toContain("FakeGoogleAccessToken0123456789");
	});

	it("refuses when the host's resolver throws", async () => {
		expect(
			await codeOf(() =>
				readTopic(always(raw(404, "")), {
					resolveCredential: async () => {
						throw new Error("vault is sealed");
					},
				}),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("quotes the host's reason so the operator can fix it", async () => {
		expect(
			await messageOf(() =>
				readTopic(always(raw(404, "")), {
					resolveCredential: async () => {
						throw new Error("vault is sealed");
					},
				}),
			),
		).toContain("vault is sealed");
	});

	it("survives a host that throws a non-Error", async () => {
		expect(
			await codeOf(() =>
				readTopic(always(raw(404, "")), {
					resolveCredential: async () => {
						throw "sealed";
					},
				}),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("refuses when the host resolves the ref to nothing", async () => {
		// Carrying on unauthenticated surfaces at Google as a 401 about
		// permissions, sending the operator to look at IAM when the real problem
		// is a reference nobody registered.
		expect(
			await codeOf(() =>
				readTopic(always(raw(404, "")), {
					resolveCredential: async () => "   ",
				}),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});
});

describe("routing", () => {
	it("refuses a request for another product", async () => {
		// Picking a resolver by hand and handing it the wrong request would send a
		// bucket's desired shape down the topic create path.
		expect(
			await codeOf(() =>
				resolverFor(GCP_PUBSUB_TOPIC_PRODUCT_ID).read(
					request({ productId: GCP_CLOUD_STORAGE_PRODUCT_ID }),
					always(raw(404, "")),
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("says to route through the registry", async () => {
		expect(
			await messageOf(() =>
				resolverFor(GCP_PUBSUB_TOPIC_PRODUCT_ID).read(
					request({ productId: GCP_CLOUD_STORAGE_PRODUCT_ID }),
					always(raw(404, "")),
				),
			),
		).toContain("route the request through the registry");
	});

	it("has no resolver for a product id nobody registered", () => {
		expect(gcpResolverRegistry(options()).get("gcp:nonesuch")).toBeUndefined();
	});
});

describe("reading the body", () => {
	it("treats an empty success body as an empty record", async () => {
		// Google answers some calls with no content; treating that as unparseable
		// would turn a success into a failure.
		const outcome = await readTopic(always(raw(200, "")));
		expect(outcome).toBeDefined();
	});

	it("refuses a success body that is not JSON", async () => {
		// An HTML error page from a proxy is the usual source. The effect of the
		// call is unknown, and unknown is refused rather than assumed either way.
		expect(await codeOf(() => readTopic(always(raw(200, "<html>oops"))))).toBe(
			"RESOLVER_OUTPUT_UNPARSEABLE",
		);
	});

	it("says the outcome is unknown rather than guessing", async () => {
		expect(
			await messageOf(() => readTopic(always(raw(200, "<html>oops")))),
		).toContain("refused rather than assumed");
	});

	it("refuses JSON that is not an object", async () => {
		expect(await codeOf(() => readTopic(always(raw(200, "[1,2,3]"))))).toBe(
			"RESOLVER_OUTPUT_UNPARSEABLE",
		);
	});

	it("says the resource cannot be identified", async () => {
		expect(
			await messageOf(() => readTopic(always(raw(200, "[1,2,3]")))),
		).toContain("cannot be identified");
	});
});

describe("provider refusals", () => {
	it("quotes Google's status and message", async () => {
		expect(
			await messageOf(() =>
				readTopic(
					always(
						json(403, {
							error: {
								code: 403,
								status: "PERMISSION_DENIED",
								message: "caller lacks pubsub.topics.get",
							},
						}),
					),
				),
			),
		).toContain("PERMISSION_DENIED: caller lacks pubsub.topics.get");
	});

	it("redacts token-shaped text in Google's message", async () => {
		// Google echoes request context in `error.message`, and that context has
		// carried token fragments.
		expect(
			await messageOf(() =>
				readTopic(
					always(
						json(401, { error: { message: `token ${TOKEN} is invalid` } }),
					),
				),
			),
		).not.toContain("FakeGoogleAccessToken0123456789");
	});

	it("says so plainly when Google sent no detail", async () => {
		expect(await messageOf(() => readTopic(always(json(500, {}))))).toContain(
			"no error detail was returned",
		);
	});

	it("falls back to a redacted snippet when the error body is not JSON", async () => {
		// A proxy's plain-text page still tells the operator something;
		// discarding it would leave them with only a status code.
		expect(
			await messageOf(() => readTopic(always(raw(502, "upstream reset")))),
		).toContain("upstream reset");
	});

	it("still names the status when the error body is empty", async () => {
		expect(await messageOf(() => readTopic(always(raw(503, ""))))).toContain(
			"status 503",
		);
	});

	it("carries the typed code, not just a message", async () => {
		// The lane branches on the code; a stringly-typed failure would collapse
		// "provider said no" into "something went wrong".
		expect(await codeOf(() => readTopic(always(raw(503, ""))))).toBe(
			"RESOLVER_PROVIDER_REJECTED",
		);
	});
});

describe("adopt versus noop", () => {
	it("adopts a topic the request did not know about", async () => {
		// Adopting something unmanaged is a fact an operator should see in the
		// audit record, not something folded into "nothing happened".
		const outcome = await readTopic(always(json(200, { name: "x" })));
		expect(outcome?.action).toBe("adopt");
	});

	it("reports noop when the caller already named the physical id", async () => {
		const outcome = await readTopic(
			always(json(200, { name: "x" })),
			{},
			{ physicalId: `projects/${PROJECT_ID}/topics/thing` },
		);
		expect(outcome?.action).toBe("noop");
	});

	it("reports a missing topic as absent", async () => {
		expect(await readTopic(always(raw(404, "")))).toBeUndefined();
	});
});

describe("Cloud Run", () => {
	const location = "us-central1";
	const IMAGE = "us-docker.pkg.dev/p/r/app:sha256-abc";
	const operationName = `projects/${PROJECT_ID}/locations/${location}/operations/op-1`;

	function runRequest(desired: Rec) {
		return parseResolveRequest({
			ref: {
				slot: "service",
				productId: GCP_CLOUD_RUN_PRODUCT_ID,
				logicalId: "thing",
			},
			desired: { location, ...desired },
			credentialRef: CREDENTIAL_REF,
		});
	}

	function reconcileRun(desired: Rec, transport: HttpTransport) {
		return resolverFor(GCP_CLOUD_RUN_PRODUCT_ID).reconcile(
			runRequest(desired),
			transport,
		);
	}

	it("refuses a create with no image", async () => {
		// Cloud Run has nothing to run without one, and guessing an image means
		// deploying code nobody chose.
		expect(await codeOf(() => reconcileRun({}, always(raw(404, ""))))).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
	});

	it("says the image is never guessed", async () => {
		expect(
			await messageOf(() => reconcileRun({}, always(raw(404, "")))),
		).toContain("never guessed here");
	});

	it("says a create is not confirmed while its operation is running", async () => {
		// A service that is not yet serving must not be reported as deployed; the
		// next lane step would route traffic at nothing.
		const outcome = await reconcileRun(
			{ image: IMAGE },
			sequence(raw(404, ""), json(200, { name: operationName, done: false })),
		);
		expect(outcome.outputs.operationConfirmed).toBe(false);
		expect(outcome.diagnostics.join(" ")).toContain("NOT confirmed ready");
	});

	it("confirms a create whose operation reports done", async () => {
		const outcome = await reconcileRun(
			{ image: IMAGE },
			sequence(
				raw(404, ""),
				json(200, { name: operationName, done: true }),
				json(200, {
					name: `projects/${PROJECT_ID}/locations/${location}/services/thing`,
					uri: "https://thing-x.run.app",
					generation: "1",
					observedGeneration: "1",
					terminalCondition: { state: "CONDITION_SUCCEEDED" },
				}),
			),
		);
		expect(outcome.outputs.operationConfirmed).toBe(true);
	});

	it("does not invent outputs when the post-create read finds nothing", async () => {
		const outcome = await reconcileRun(
			{ image: IMAGE },
			sequence(
				raw(404, ""),
				json(200, { name: operationName, done: true }),
				raw(404, ""),
			),
		);
		expect(outcome.diagnostics.join(" ")).toContain(
			"rather than with invented ones",
		);
	});

	it("leaves a service alone when nothing drifted", async () => {
		// A PATCH that changes nothing still creates a new Cloud Run revision.
		const outcome = await reconcileRun(
			{ image: IMAGE },
			always(
				json(200, {
					name: `projects/${PROJECT_ID}/locations/${location}/services/thing`,
					template: { containers: [{ image: IMAGE }] },
				}),
			),
		);
		expect(outcome.action).toBe("adopt");
	});

	it("patches an image that drifted, and says so", async () => {
		const outcome = await reconcileRun(
			{ image: IMAGE },
			sequence(
				json(200, {
					name: `projects/${PROJECT_ID}/locations/${location}/services/thing`,
					template: { containers: [{ image: "old:1" }] },
				}),
				json(200, { name: operationName, done: true }),
				json(200, {
					name: `projects/${PROJECT_ID}/locations/${location}/services/thing`,
					template: { containers: [{ image: IMAGE }] },
				}),
			),
		);
		expect(outcome.action).toBe("update");
		expect(outcome.diagnostics.join(" ")).toContain("applied service settings");
	});

	it("carries the observed image into an update that does not name one", async () => {
		// A Cloud Run PATCH carries the whole template, so an update that changes
		// only ingress still needs an image. Omitting it would blank the
		// container and take the service down.
		const outcome = await reconcileRun(
			{ ingress: "internal" },
			sequence(
				json(200, {
					name: `projects/${PROJECT_ID}/locations/${location}/services/thing`,
					ingress: "all",
					template: { containers: [{ image: IMAGE }] },
				}),
				json(200, { name: operationName, done: true }),
				json(200, {
					name: `projects/${PROJECT_ID}/locations/${location}/services/thing`,
					ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY",
					template: { containers: [{ image: IMAGE }] },
				}),
			),
		);
		expect(outcome.action).toBe("update");
	});

	it("refuses an update when no image can be found anywhere", async () => {
		// Neither the request nor the observed service names one, so the body
		// cannot be composed without inventing a container.
		expect(
			await codeOf(() =>
				reconcileRun(
					{ ingress: "internal" },
					always(
						json(200, {
							name: `projects/${PROJECT_ID}/locations/${location}/services/thing`,
							ingress: "all",
						}),
					),
				),
			),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("says an update is not confirmed while its operation is running", async () => {
		const outcome = await reconcileRun(
			{ image: "new:2" },
			sequence(
				json(200, {
					name: `projects/${PROJECT_ID}/locations/${location}/services/thing`,
					template: { containers: [{ image: IMAGE }] },
				}),
				json(200, { name: operationName, done: false }),
			),
		);
		expect(outcome.outputs.operationConfirmed).toBe(false);
	});
});

describe("Memorystore, where the operation machinery shows", () => {
	const location = "us-central1";

	function redisRequest(desired: Rec) {
		return parseResolveRequest({
			ref: {
				slot: "kv",
				productId: GCP_MEMORYSTORE_REDIS_PRODUCT_ID,
				logicalId: "thing",
			},
			desired: { location, ...desired },
			credentialRef: CREDENTIAL_REF,
		});
	}

	function reconcileRedis(
		desired: Rec,
		transport: HttpTransport,
		overrides: Partial<GcpResolverOptions> = {},
	) {
		return resolverFor(GCP_MEMORYSTORE_REDIS_PRODUCT_ID, overrides).reconcile(
			redisRequest(desired),
			transport,
		);
	}

	function readRedis(desired: Rec, transport: HttpTransport) {
		return resolverFor(GCP_MEMORYSTORE_REDIS_PRODUCT_ID).read(
			redisRequest(desired),
			transport,
		);
	}

	const operationName = `projects/${PROJECT_ID}/locations/${location}/operations/op-1`;

	it("refuses a request with no location", async () => {
		// Google's regions span jurisdictions, so a default here is a residency
		// decision this resolver may not take.
		expect(
			await codeOf(() =>
				resolverFor(GCP_MEMORYSTORE_REDIS_PRODUCT_ID).read(
					parseResolveRequest({
						ref: {
							slot: "kv",
							productId: GCP_MEMORYSTORE_REDIS_PRODUCT_ID,
							logicalId: "thing",
						},
						desired: {},
						credentialRef: CREDENTIAL_REF,
					}),
					always(raw(404, "")),
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("refuses a tier it cannot map to Google's enum", async () => {
		// A silently mistranslated tier is a silently different availability
		// guarantee: Basic is one node with no failover.
		expect(
			await codeOf(() =>
				reconcileRedis({ tier: "premium", memoryGb: 1 }, always(raw(404, ""))),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("names the tiers it accepts", async () => {
		expect(
			await messageOf(() =>
				reconcileRedis({ tier: "premium", memoryGb: 1 }, always(raw(404, ""))),
			),
		).toContain("basic, standard-ha");
	});

	it("refuses a version that is not the full enum", async () => {
		// `REDIS_7_0`, never composed from a bare "7" — a resolver that built the
		// enum itself would guess wrong the first time Google changed the shape.
		expect(
			await codeOf(() =>
				reconcileRedis(
					{ engineVersion: "7", memoryGb: 1 },
					always(raw(404, "")),
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it.each([
		["no memoryGb at all", {}],
		["a zero memoryGb", { memoryGb: 0 }],
		["a fractional memoryGb", { memoryGb: 1.5 }],
	])("refuses a create with %s", async (_label, size) => {
		// A guessed size is a guessed bill *and* a guessed capacity ceiling, and
		// the smallest legal value differs by tier, so there is no harmless
		// default to fall back to.
		expect(await codeOf(() => reconcileRedis(size, always(raw(404, ""))))).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
	});

	it("says a create is not confirmed while its operation is still running", async () => {
		// The instance is not serving. Reporting a finished create would let the
		// next lane step hand a workload a connection string to nothing.
		const outcome = await reconcileRedis(
			{ memoryGb: 1, tier: "basic" },
			sequence(
				raw(404, ""),
				json(200, { name: operationName, done: false }),
				json(200, { name: operationName, done: false }),
			),
		);
		expect(outcome.outputs.operationConfirmed).toBe(false);
		expect(outcome.diagnostics.join(" ")).toContain("NOT confirmed ready");
	});

	it("says how to converge an unconfirmed create", async () => {
		const outcome = await reconcileRedis(
			{ memoryGb: 1, tier: "basic" },
			sequence(raw(404, ""), json(200, { name: operationName, done: false })),
		);
		expect(outcome.diagnostics.join(" ")).toContain(
			"raise the operationPoll budget",
		);
	});

	it("confirms a create whose operation reports done", async () => {
		const outcome = await reconcileRedis(
			{ memoryGb: 1, tier: "basic" },
			sequence(
				raw(404, ""),
				json(200, { name: operationName, done: true }),
				json(200, { name: "thing", host: "10.0.0.5", port: 6379 }),
			),
		);
		expect(outcome.outputs.operationConfirmed).toBe(true);
		expect(outcome.outputs.host).toBe("10.0.0.5");
	});

	it("does not invent outputs when the post-create read finds nothing", async () => {
		// The operation completed and the instance is not there. Reporting
		// invented outputs would be worse than reporting none.
		const outcome = await reconcileRedis(
			{ memoryGb: 1, tier: "basic" },
			sequence(
				raw(404, ""),
				json(200, { name: operationName, done: true }),
				raw(404, ""),
			),
		);
		expect(outcome.outputs).not.toHaveProperty("host");
		expect(outcome.diagnostics.join(" ")).toContain(
			"rather than with invented",
		);
	});

	it("warns when no tier was declared", async () => {
		// Memorystore's own default is a single node with no replica and no
		// failover. Accepting it silently means a production cache with no
		// failover that nobody chose.
		const outcome = await reconcileRedis(
			{ memoryGb: 1 },
			sequence(
				raw(404, ""),
				json(200, { name: operationName, done: true }),
				json(200, { name: "thing" }),
			),
		);
		expect(outcome.diagnostics.join(" ")).toContain(
			"Memorystore applied its own default",
		);
	});

	it("refuses an operation whose name is not the documented shape", async () => {
		// A name this code cannot address cannot be polled, so the outcome of the
		// call is unknown.
		expect(
			await codeOf(() =>
				reconcileRedis(
					{ memoryGb: 1 },
					sequence(
						raw(404, ""),
						json(200, { name: "not-a-path", done: false }),
					),
				),
			),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("refuses an operation that finished with an error", async () => {
		// A failed operation is a failed create, not a create to report.
		expect(
			await codeOf(() =>
				reconcileRedis(
					{ memoryGb: 1 },
					sequence(
						raw(404, ""),
						json(200, {
							name: operationName,
							done: true,
							error: { message: "quota exceeded" },
						}),
					),
				),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});

	it("quotes the operation's error", async () => {
		expect(
			await messageOf(() =>
				reconcileRedis(
					{ memoryGb: 1 },
					sequence(
						raw(404, ""),
						json(200, {
							name: operationName,
							done: true,
							error: { message: "quota exceeded" },
						}),
					),
				),
			),
		).toContain("quota exceeded");
	});

	it("reads Cloud SQL's errors array as well as the LRO message", async () => {
		// Two vocabularies for the same fact; handling only one would report a
		// failed operation as a silent success.
		expect(
			await messageOf(() =>
				reconcileRedis(
					{ memoryGb: 1 },
					sequence(
						raw(404, ""),
						json(200, {
							name: operationName,
							done: true,
							error: { errors: [{ message: "bad network" }] },
						}),
					),
				),
			),
		).toContain("bad network");
	});

	it("reports a failure with a code when there is no message at all", async () => {
		// Silence would read as success.
		expect(
			await messageOf(() =>
				reconcileRedis(
					{ memoryGb: 1 },
					sequence(
						raw(404, ""),
						json(200, {
							name: operationName,
							done: true,
							error: { code: 8 },
						}),
					),
				),
			),
		).toContain("failed with code 8");
	});

	it("reports a bare failure when there is neither message nor code", async () => {
		expect(
			await messageOf(() =>
				reconcileRedis(
					{ memoryGb: 1 },
					sequence(
						raw(404, ""),
						json(200, { name: operationName, done: true, error: {} }),
					),
				),
			),
		).toContain("failed without a message");
	});

	it("does not poll at all when the budget is zero", async () => {
		// A caller that wants to fire and check later is making a legitimate
		// choice; spending a poll anyway would ignore what they asked for.
		let calls = 0;
		const outcome = await reconcileRedis(
			{ memoryGb: 1, tier: "basic" },
			async () => {
				calls += 1;
				return calls === 1
					? raw(404, "")
					: json(200, { name: operationName, done: false });
			},
			{ operationPoll: { attempts: 0 } },
		);
		expect(calls).toBe(2);
		expect(outcome.outputs.operationConfirmed).toBe(false);
	});

	it("waits between polls when the host injects a pause", async () => {
		// The pause is injected rather than taken from a timer so a test can
		// observe it without spending the wall-clock time.
		const waited: number[] = [];
		await reconcileRedis(
			{ memoryGb: 1, tier: "basic" },
			sequence(raw(404, ""), json(200, { name: operationName, done: false })),
			{
				operationPoll: {
					attempts: 2,
					beforeAttempt: async (attempt) => {
						waited.push(attempt);
					},
				},
			},
		);
		expect(waited).toEqual([1, 2]);
	});

	it("reports tier drift rather than destroying the cache", async () => {
		// Memorystore fixes the tier at creation; converging it would mean
		// replacing the instance and dropping everything in it.
		const outcome = await readRedis(
			{ tier: "standard-ha" },
			always(json(200, { name: "thing", tier: "BASIC" })),
		);
		expect(outcome?.diagnostics.join(" ")).toContain("destroying the cache");
	});

	it("reports location drift", async () => {
		const outcome = await readRedis(
			{},
			always(json(200, { name: "thing", locationId: "europe-west1-b" })),
		);
		expect(outcome?.diagnostics.join(" ")).toContain("cannot move");
	});

	it("accepts a zone inside the requested region", async () => {
		// `us-central1-a` is inside `us-central1`; reporting drift for it would
		// be noise on every reconcile of a zonal instance.
		const outcome = await readRedis(
			{},
			always(json(200, { name: "thing", locationId: "us-central1-a" })),
		);
		expect(outcome?.diagnostics).toEqual([]);
	});

	it("omits instance fields Google did not send", async () => {
		// Publishing `host: undefined` would make a binding believe it has an
		// address to connect to.
		const outcome = await readRedis({}, always(json(200, { name: "thing" })));
		expect(outcome?.outputs).toEqual({
			instanceId: "thing",
			resourceName: `projects/${PROJECT_ID}/locations/${location}/instances/thing`,
		});
	});
});

describe("Cloud Storage bucket settings", () => {
	function bucketRequest(desired: Rec) {
		return parseResolveRequest({
			ref: {
				slot: "bucket",
				productId: GCP_CLOUD_STORAGE_PRODUCT_ID,
				logicalId: "thing",
			},
			desired,
			credentialRef: CREDENTIAL_REF,
		});
	}

	function reconcileBucket(desired: Rec, transport: HttpTransport) {
		return resolverFor(GCP_CLOUD_STORAGE_PRODUCT_ID).reconcile(
			bucketRequest(desired),
			transport,
		);
	}

	function readBucket(desired: Rec, transport: HttpTransport) {
		return resolverFor(GCP_CLOUD_STORAGE_PRODUCT_ID).read(
			bucketRequest(desired),
			transport,
		);
	}

	it("creates a bucket that is not there", async () => {
		const outcome = await reconcileBucket(
			{ location: "US" },
			sequence(raw(404, ""), json(200, { name: "thing", location: "US" })),
		);
		expect(outcome.action).toBe("create");
	});

	it("compares the storage class case-insensitively", async () => {
		// GCS reports `storageClass` upper-cased. A case-sensitive compare would
		// report permanent drift on a bucket that is exactly as requested, and
		// send a PATCH on every single reconcile forever.
		const outcome = await reconcileBucket(
			{ storageClass: "nearline" },
			always(json(200, { name: "thing", storageClass: "NEARLINE" })),
		);
		expect(outcome.action).toBe("adopt");
	});

	it("patches a storage class that really differs", async () => {
		const outcome = await reconcileBucket(
			{ storageClass: "coldline" },
			sequence(
				json(200, { name: "thing", storageClass: "NEARLINE" }),
				json(200, { name: "thing", storageClass: "COLDLINE" }),
			),
		);
		expect(outcome.action).toBe("update");
		expect(outcome.diagnostics.join(" ")).toContain("storageClass");
	});

	it("treats an unset versioning block as disabled", async () => {
		// A bucket that has never had versioning configured is not versioned, so
		// asking for `false` must not send a PATCH that changes nothing.
		const outcome = await reconcileBucket(
			{ versioning: false },
			always(json(200, { name: "thing" })),
		);
		expect(outcome.action).toBe("adopt");
	});

	it("enables versioning on a bucket that has none", async () => {
		const outcome = await reconcileBucket(
			{ versioning: true },
			sequence(
				json(200, { name: "thing" }),
				json(200, { name: "thing", versioning: { enabled: true } }),
			),
		);
		expect(outcome.action).toBe("update");
	});

	it("treats an unset uniform access block as disabled", async () => {
		const outcome = await reconcileBucket(
			{ uniformBucketLevelAccess: false },
			always(json(200, { name: "thing" })),
		);
		expect(outcome.action).toBe("adopt");
	});

	it("enables uniform bucket-level access when asked", async () => {
		// Uniform access is what makes per-object ACLs stop applying; a bucket
		// that silently kept them would have two access models at once.
		const outcome = await reconcileBucket(
			{ uniformBucketLevelAccess: true },
			sequence(
				json(200, { name: "thing" }),
				json(200, {
					name: "thing",
					iamConfiguration: { uniformBucketLevelAccess: { enabled: true } },
				}),
			),
		);
		expect(outcome.action).toBe("update");
		expect(outcome.outputs.uniformBucketLevelAccess).toBe(true);
	});

	it("maps publicAccessBlocked true to enforced", async () => {
		const outcome = await reconcileBucket(
			{ publicAccessBlocked: true },
			sequence(json(200, { name: "thing" }), json(200, { name: "thing" })),
		);
		expect(outcome.action).toBe("update");
	});

	it("maps publicAccessBlocked false to inherited, not to enforced", async () => {
		// `inherited` is the org-policy default rather than an explicit
		// permission to be public — collapsing the two would either lock a bucket
		// nobody asked to lock or unlock one an org policy protects.
		const outcome = await reconcileBucket(
			{ publicAccessBlocked: false },
			always(
				json(200, {
					name: "thing",
					iamConfiguration: { publicAccessPrevention: "inherited" },
				}),
			),
		);
		expect(outcome.action).toBe("adopt");
	});

	it("sends no patch when nothing drifted", async () => {
		// A PATCH that changes nothing still shows up in an audit log as a
		// mutation and still costs a request against the quota.
		const outcome = await reconcileBucket(
			{},
			always(json(200, { name: "thing" })),
		);
		expect(outcome.action).toBe("adopt");
	});

	it("names every setting it applied, sorted", async () => {
		// The diagnostic is the operator's record of what a reconcile changed;
		// sorting makes it a function of the settings rather than of iteration
		// order, so two identical deploys read identically.
		const outcome = await reconcileBucket(
			{ versioning: true, storageClass: "COLDLINE" },
			sequence(json(200, { name: "thing" }), json(200, { name: "thing" })),
		);
		expect(outcome.diagnostics[0]).toBe(
			"applied bucket settings: storageClass, versioning",
		);
	});

	it("reports location drift rather than replacing the bucket", async () => {
		// A bucket's location is immutable, so "converging" it would mean
		// destroying the data in it.
		const outcome = await readBucket(
			{ location: "EU" },
			always(json(200, { name: "thing", location: "US" })),
		);
		expect(outcome?.diagnostics.join(" ")).toContain("destroying the data");
	});

	it("compares locations case-insensitively", async () => {
		// GCS reports `US`; a manifest saying `us` means the same place, and
		// reporting drift for it would be noise on every reconcile.
		const outcome = await readBucket(
			{ location: "us" },
			always(json(200, { name: "thing", location: "US" })),
		);
		expect(outcome?.diagnostics).toEqual([]);
	});

	it("accepts region as a synonym for location", async () => {
		const outcome = await readBucket(
			{ region: "US" },
			always(json(200, { name: "thing", location: "US" })),
		);
		expect(outcome?.diagnostics).toEqual([]);
	});

	it("omits bucket fields the provider did not send", async () => {
		// Publishing `location: undefined` would make a binding believe it knows
		// where the data lives.
		const outcome = await readBucket({}, always(json(200, { name: "thing" })));
		expect(outcome?.outputs).toEqual({ bucketName: "thing" });
	});

	it("treats a 404 on delete as already gone", async () => {
		await expect(
			resolverFor(GCP_CLOUD_STORAGE_PRODUCT_ID).delete(
				bucketRequest({}),
				always(raw(404, "")),
			),
		).resolves.toBeUndefined();
	});

	it("still refuses a delete the provider rejected for another reason", async () => {
		// 409 on a bucket delete is "not empty", which is emphatically not
		// "already gone" — reporting success would claim a teardown that left the
		// data and the bill in place.
		expect(
			await codeOf(() =>
				resolverFor(GCP_CLOUD_STORAGE_PRODUCT_ID).delete(
					bucketRequest({}),
					always(json(409, { error: { message: "bucket not empty" } })),
				),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});
});

describe("Pub/Sub topic behaviour", () => {
	function reconcileTopic(desired: Rec, transport: HttpTransport) {
		return resolverFor(GCP_PUBSUB_TOPIC_PRODUCT_ID).reconcile(
			request({ productId: GCP_PUBSUB_TOPIC_PRODUCT_ID, desired }),
			transport,
		);
	}

	it("creates a topic that is not there", async () => {
		const outcome = await reconcileTopic(
			{},
			sequence(raw(404, ""), json(200, { name: "x" })),
		);
		expect(outcome.action).toBe("create");
	});

	it("adopts a topic another writer created between the read and the create", async () => {
		// The 409 alone would not say whose topic won. The answer comes from a
		// re-read, not a shrug — and the adoption is stated in a diagnostic
		// rather than presented as an ordinary create.
		const outcome = await reconcileTopic(
			{},
			sequence(
				raw(404, ""),
				json(409, { error: { status: "ALREADY_EXISTS" } }),
				json(200, { name: "x" }),
			),
		);
		expect(outcome.action).toBe("adopt");
		expect(outcome.diagnostics.join(" ")).toContain("created concurrently");
	});

	it("refuses when the 409 re-read finds nothing", async () => {
		// Pub/Sub says it exists and a read says it does not. Creating another
		// would risk a duplicate, so the contradiction is reported rather than
		// resolved by guessing.
		expect(
			await codeOf(() =>
				reconcileTopic(
					{},
					sequence(
						raw(404, ""),
						json(409, { error: { status: "ALREADY_EXISTS" } }),
						raw(404, ""),
					),
				),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});

	it("updates the retention when it differs", async () => {
		const outcome = await reconcileTopic(
			{ messageRetentionSeconds: 600 },
			sequence(
				json(200, { name: "x", messageRetentionDuration: "300s" }),
				json(200, { name: "x", messageRetentionDuration: "600s" }),
			),
		);
		expect(outcome.action).toBe("update");
		expect(outcome.outputs.messageRetentionDuration).toBe("600s");
	});

	it("leaves a matching retention alone", async () => {
		// A PATCH that changes nothing still shows up in an audit log as a
		// mutation and still costs a request against the quota.
		const outcome = await reconcileTopic(
			{ messageRetentionSeconds: 600 },
			always(json(200, { name: "x", messageRetentionDuration: "600s" })),
		);
		expect(outcome.action).toBe("adopt");
	});

	it("leaves retention alone when the request does not name one", async () => {
		const outcome = await reconcileTopic(
			{},
			always(json(200, { name: "x", messageRetentionDuration: "300s" })),
		);
		expect(outcome.action).toBe("adopt");
	});

	it("says messageOrdering was declared but not applied", async () => {
		// Ordering is set per publish request and per subscription, not on the
		// topic resource. Silently dropping the field would leave an operator
		// believing their messages are ordered when nothing enforces it.
		const outcome = await reconcileTopic(
			{ messageOrdering: true },
			always(json(200, { name: "x" })),
		);
		expect(outcome.diagnostics.join(" ")).toContain("not applied");
	});

	it("says schemaId was declared but not applied", async () => {
		// Attaching a schema also needs a message encoding this record does not
		// carry, and guessing one would attach the wrong contract to the topic.
		const outcome = await reconcileTopic(
			{ schemaId: "orders-v1" },
			always(json(200, { name: "x" })),
		);
		expect(outcome.diagnostics.join(" ")).toContain(
			"guessing one would attach the wrong contract",
		);
	});

	it("says nothing extra for a plain topic", async () => {
		// A diagnostic on a healthy resource trains operators to ignore them.
		const outcome = await reconcileTopic({}, always(json(200, { name: "x" })));
		expect(outcome.diagnostics).toEqual([]);
	});

	it("omits the retention output when the topic has none", async () => {
		// Publishing `messageRetentionDuration: undefined` would make a binding
		// believe a retention was configured.
		const outcome = await readTopic(always(json(200, { name: "x" })));
		expect(outcome?.outputs).not.toHaveProperty("messageRetentionDuration");
	});

	it("deletes a topic that exists", async () => {
		await expect(
			resolverFor(GCP_PUBSUB_TOPIC_PRODUCT_ID).delete(
				request({ productId: GCP_PUBSUB_TOPIC_PRODUCT_ID }),
				always(raw(200, "")),
			),
		).resolves.toBeUndefined();
	});

	it("treats a 404 on delete as already gone", async () => {
		// Two reconciles racing is normal, and absence is the goal state.
		await expect(
			resolverFor(GCP_PUBSUB_TOPIC_PRODUCT_ID).delete(
				request({ productId: GCP_PUBSUB_TOPIC_PRODUCT_ID }),
				always(raw(404, "")),
			),
		).resolves.toBeUndefined();
	});

	it("still refuses a delete the provider rejected for another reason", async () => {
		// 404 is absence; 403 is "you may not". Folding the second into the first
		// would report a successful teardown that left the topic in place.
		expect(
			await codeOf(() =>
				resolverFor(GCP_PUBSUB_TOPIC_PRODUCT_ID).delete(
					request({ productId: GCP_PUBSUB_TOPIC_PRODUCT_ID }),
					always(json(403, { error: { status: "PERMISSION_DENIED" } })),
				),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});
});
