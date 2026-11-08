/**
 * Azure resolver edges — the ARM write-settlement machinery and the wrapper.
 *
 * The suite next door drives the happy shapes. This file drives the part that
 * decides whether a write *landed*, which on ARM is genuinely hard: a write can
 * answer three different ways, and getting it wrong has one specific, terrible
 * failure mode.
 *
 * **A `202` read as a completed create is the worst thing a resolver can do.**
 * The deploy says the resource exists, the next step binds to it, and nothing
 * is there. So every path through `settleWrite` either confirms the write or
 * says plainly that it could not — never silence, and never an assumption.
 * The three shapes are all handled in one place so no product can grow its own
 * opinion about what a `202` means:
 *
 *  - `202`: follow `Azure-AsyncOperation` if present, else `Location`.
 *  - `200`/`201` with a non-terminal `provisioningState`: poll the resource.
 *  - `200`/`201` with a terminal or absent state: already done — a blob
 *    container has no provisioning phase at all.
 *
 * Two more properties carry weight here:
 *
 * **The operation URL is allowlisted before the bearer token follows it.** ARM
 * hands back a URL to poll. Following one that points somewhere else would send
 * an ARM token to a host of somebody else's choosing, so an off-surface URL is
 * refused rather than followed.
 *
 * **A delete raises rather than returning.** `delete()` has no diagnostics
 * channel, so an unconfirmed delete has nowhere to put its honesty except an
 * exception — and the delete is idempotent, so re-running converges.
 *
 * Everything runs through an injected fake transport with an injected poll
 * spacing. No network, no credential, no Azure subscription.
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
	AZURE_BLOB_STORAGE_PRODUCT_ID,
	AZURE_CONTAINER_APPS_PRODUCT_ID,
	AZURE_DEFAULT_POLL_BUDGET,
	AZURE_MAX_POLL_BUDGET,
	AZURE_REDIS_CACHE_PRODUCT_ID,
	type AzureResolverOptions,
	azureResolverRegistry,
	redactAzureText,
} from "../src/index.js";
import type { JsonObject, JsonValue } from "../src/json.js";

type Rec = JsonObject;
type ResolverProbe =
	| (() => Promise<ResolveOutcome | undefined>)
	| (() => Promise<void>);

const CREDENTIAL_REF = "env://AZURE_ARM_ACCESS_TOKEN";
/** A JWT-shaped ARM bearer token. Never expected anywhere but a header. */
const TOKEN =
	"eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJodHRwczovL21hbmFnZW1lbnQuYXp1cmUuY29tIn0.fakesignaturewithrealisticlengthabcdefghij";
const SUBSCRIPTION_ID = "00000000-0000-4000-8000-000000000000";
const RESOURCE_GROUP = "hobo-test-rg";

function options(
	overrides: Partial<AzureResolverOptions> = {},
): AzureResolverOptions {
	return {
		subscriptionId: SUBSCRIPTION_ID,
		resourceGroup: RESOURCE_GROUP,
		resolveCredential: async () => TOKEN,
		...overrides,
	};
}

function resolverFor(
	productId: string,
	overrides: Partial<AzureResolverOptions> = {},
): ResourceResolver {
	const resolver = azureResolverRegistry(options(overrides)).get(productId);
	if (resolver === undefined) {
		throw new Error(`no resolver registered for ${productId}`);
	}
	return resolver;
}

function request(input: {
	readonly productId: string;
	readonly slot?: string;
	readonly logicalId?: string;
	readonly physicalId?: string;
	readonly desired?: Rec;
	readonly credentialRef?: string;
}): ResolveRequest {
	return parseResolveRequest({
		ref: {
			slot: input.slot ?? "kv",
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

function json(
	status: number,
	payload: JsonValue,
	headers: Readonly<Record<string, string>> = {},
): TransportResponse {
	return {
		status,
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(payload),
	};
}

function raw(
	status: number,
	body: string,
	headers: Readonly<Record<string, string>> = {},
): TransportResponse {
	return { status, headers, body };
}

/** An ARM operation URL on the allowlisted surface. */
const OPERATION_URL = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/providers/Microsoft.Cache/locations/eastus/operationResults/op-1`;

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

/** A cache create: the read answers 404, then the PUT answers however asked. */
function createCache(
	putResponse: TransportResponse,
	...rest: readonly TransportResponse[]
) {
	return resolverFor(AZURE_REDIS_CACHE_PRODUCT_ID).reconcile(
		request({
			productId: AZURE_REDIS_CACHE_PRODUCT_ID,
			desired: { location: "eastus", skuName: "Basic", capacity: 1 },
		}),
		sequence(raw(404, ""), putResponse, ...rest),
	);
}

// ---------------------------------------------------------------------------

describe("redaction", () => {
	it("scrubs a bearer token", () => {
		// An AAD bearer token is a JWT whose every segment is long and
		// token-shaped, which is exactly what the pattern catches — each segment
		// separately, since the dots break the run.
		expect(redactAzureText(`bearer ${TOKEN} rejected`)).not.toContain(
			"fakesignature",
		);
	});

	it("leaves a run shorter than the threshold intact", () => {
		// The threshold is twenty characters. That is a deliberate floor rather
		// than an oversight: below it, the pattern would start eating ordinary
		// identifiers — resource names, ARM error codes, region slugs — and a
		// diagnostic made of redaction markers is a diagnostic nobody reads.
		// Every segment of a real JWT is well past it.
		expect(redactAzureText("code SkuNotAvailable")).toBe(
			"code SkuNotAvailable",
		);
	});

	it("scrubs a subscription GUID", () => {
		// ARM echoes request context in `error.message`, and that context is the
		// subscription id more often than not.
		expect(redactAzureText(`subscription ${SUBSCRIPTION_ID} denied`)).toContain(
			"[redacted]",
		);
	});

	it("leaves short words alone", () => {
		// Redacting ordinary prose makes provider errors unreadable, and an
		// unreadable error gets ignored rather than acted on.
		expect(redactAzureText("cache is full")).toBe("cache is full");
	});

	it("truncates long text with an ellipsis", () => {
		const scrubbed = redactAzureText("ab cd ".repeat(200), 100);
		expect(scrubbed).toHaveLength(101);
		expect(scrubbed.endsWith("…")).toBe(true);
	});

	it("does not append an ellipsis to text that fits", () => {
		expect(redactAzureText("short", 100).endsWith("…")).toBe(false);
	});
});

describe("the subscription and resource group", () => {
	it.each([
		["an empty string", ""],
		["a non-GUID", "my-subscription"],
		["a GUID with a wrong-length group", "0000-0000-0000-0000"],
	])("refuses a subscriptionId that is %s", (_label, subscriptionId) => {
		// Every ARM path is subscription-scoped, and a malformed id would be
		// pasted straight into a URL path.
		expect(() => azureResolverRegistry(options({ subscriptionId }))).toThrow(
			/subscriptionId GUID/u,
		);
	});

	it("accepts a well-formed GUID", () => {
		expect(() => azureResolverRegistry(options())).not.toThrow();
	});

	it.each([
		["empty", ""],
		["ending in a period", "hobo-rg."],
		["carrying a slash", "hobo/rg"],
		["longer than ninety characters", "a".repeat(91)],
	])("refuses a resourceGroup that is %s", (_label, resourceGroup) => {
		expect(() => azureResolverRegistry(options({ resourceGroup }))).toThrow(
			/resourceGroup matching ARM's name grammar/u,
		);
	});

	it("accepts the punctuation ARM actually allows", () => {
		expect(() =>
			azureResolverRegistry(options({ resourceGroup: "hobo_rg(prod)-1.2" })),
		).not.toThrow();
	});
});

describe("the poll budget", () => {
	it("has a bounded default", () => {
		expect(AZURE_DEFAULT_POLL_BUDGET).toBeGreaterThan(0);
		expect(AZURE_DEFAULT_POLL_BUDGET).toBeLessThanOrEqual(
			AZURE_MAX_POLL_BUDGET,
		);
	});

	it.each([
		0,
		-1,
		1.5,
		Number.NaN,
		AZURE_MAX_POLL_BUDGET + 1,
	])("refuses a pollBudget of %s", (pollBudget) => {
		// A config typo must not restore the unbounded loop the budget exists
		// to rule out.
		expect(() => azureResolverRegistry(options({ pollBudget }))).toThrow(
			/pollBudget between 1 and/u,
		);
	});

	it("accepts the bottom of the range", () => {
		expect(() =>
			azureResolverRegistry(options({ pollBudget: 1 })),
		).not.toThrow();
	});

	it("accepts the ceiling", () => {
		expect(() =>
			azureResolverRegistry(options({ pollBudget: AZURE_MAX_POLL_BUDGET })),
		).not.toThrow();
	});
});

describe("the credential boundary", () => {
	function readCache(
		transport: HttpTransport,
		overrides: Partial<AzureResolverOptions> = {},
		credentialRef?: string,
	) {
		return resolverFor(AZURE_REDIS_CACHE_PRODUCT_ID, overrides).read(
			request({
				productId: AZURE_REDIS_CACHE_PRODUCT_ID,
				...(credentialRef === undefined ? undefined : { credentialRef }),
			}),
			transport,
		);
	}

	it("refuses an empty credentialRef", async () => {
		expect(await codeOf(() => readCache(always(raw(404, "")), {}, "   "))).toBe(
			"RESOLVER_CREDENTIAL_MISSING",
		);
	});

	it("refuses a credentialRef that is really a token", async () => {
		// A pasted token in this field has already leaked into the event log by
		// the time anything uses it, and every request would still succeed —
		// which is what makes the leak invisible without this check.
		expect(
			await codeOf(() =>
				readCache(always(raw(404, "")), {}, "not-a-locator-token-value"),
			),
		).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
	});

	it("refuses a ref that is not a locator", async () => {
		expect(
			await codeOf(() => readCache(always(raw(404, "")), {}, "my token")),
		).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
	});

	it("never echoes a rejected ref unredacted", async () => {
		expect(
			await messageOf(() =>
				readCache(always(raw(404, "")), {}, `oops ${TOKEN}`),
			),
		).not.toContain("fakesignature");
	});

	it("refuses when the host's resolver throws", async () => {
		expect(
			await codeOf(() =>
				readCache(always(raw(404, "")), {
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
				readCache(always(raw(404, "")), {
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
				readCache(always(raw(404, "")), {
					resolveCredential: async () => {
						throw "sealed";
					},
				}),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("refuses when the host resolves the ref to nothing", async () => {
		// Carrying on unauthenticated surfaces at ARM as a 401 about permissions,
		// sending the operator to look at role assignments when the real problem
		// is a reference nobody registered.
		expect(
			await codeOf(() =>
				readCache(always(raw(404, "")), {
					resolveCredential: async () => "   ",
				}),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});
});

describe("reading an ARM body", () => {
	function readCache(transport: HttpTransport) {
		return resolverFor(AZURE_REDIS_CACHE_PRODUCT_ID).read(
			request({ productId: AZURE_REDIS_CACHE_PRODUCT_ID }),
			transport,
		);
	}

	it("refuses an empty successful resource read instead of reporting absence", async () => {
		await expect(readCache(always(raw(200, "")))).rejects.toThrow(
			/absence is not confirmed/,
		);
	});

	it("refuses a body that is not JSON", async () => {
		// An HTML error page from a proxy is the usual source, and the outcome of
		// the call is then unknown.
		expect(await codeOf(() => readCache(always(raw(200, "<html>oops"))))).toBe(
			"RESOLVER_OUTPUT_UNPARSEABLE",
		);
	});

	it("blames the pinned api-version as one possibility", async () => {
		// ARM's contract is versioned; a body this code cannot read is as likely
		// to be a version drift as a proxy, and saying so saves an hour.
		expect(
			await messageOf(() => readCache(always(raw(200, "<html>oops")))),
		).toContain("pinned api-version has changed");
	});

	it("refuses JSON that is not an ARM resource object", async () => {
		expect(await codeOf(() => readCache(always(raw(200, "[1,2,3]"))))).toBe(
			"RESOLVER_OUTPUT_UNPARSEABLE",
		);
	});

	it("quotes ARM's code and message on a refusal", async () => {
		expect(
			await messageOf(() =>
				readCache(
					always(
						json(403, {
							error: { code: "AuthorizationFailed", message: "no access" },
						}),
					),
				),
			),
		).toContain("no access");
	});

	it("reads an unwrapped error envelope too", async () => {
		// Some ARM surfaces answer with the error object at the top level.
		expect(
			await messageOf(() =>
				readCache(always(json(403, { code: "Denied", message: "nope" }))),
			),
		).toContain("nope");
	});

	it("says so plainly when ARM sent no detail", async () => {
		expect(await messageOf(() => readCache(always(raw(500, ""))))).toContain(
			"no error detail was returned",
		);
	});

	it("does not quote unredactable bytes from a non-JSON error body", async () => {
		// A non-JSON error body is still an error; it just has no detail worth
		// quoting, and quoting the raw bytes would be quoting text nothing has
		// scrubbed.
		const message = await messageOf(() =>
			readCache(always(raw(500, "<html>secret-ish content</html>"))),
		);
		expect(message).toContain("status 500");
		expect(message).not.toContain("secret-ish");
	});

	it("carries the typed code, not just a message", async () => {
		expect(await codeOf(() => readCache(always(raw(503, ""))))).toBe(
			"RESOLVER_PROVIDER_REJECTED",
		);
	});
});

describe("settling a long-running write", () => {
	it("treats an absent provisioningState as already done", async () => {
		// A blob container or a Service Bus queue has no provisioning phase at
		// all; demanding one would hang every create of a resource type that
		// never reports it.
		const outcome = await createCache(json(201, { name: "thing" }));
		expect(outcome.diagnostics.join(" ")).not.toContain("NOT confirmed");
	});

	it("treats a terminal Succeeded as done", async () => {
		const outcome = await createCache(
			json(201, {
				name: "thing",
				properties: { provisioningState: "Succeeded" },
			}),
		);
		expect(outcome.diagnostics.join(" ")).not.toContain("NOT confirmed");
	});

	it("compares the state case-insensitively", async () => {
		// ARM has answered both `Succeeded` and `succeeded`; treating them as
		// different states would report a finished create as unconfirmed.
		const outcome = await createCache(
			json(201, {
				name: "thing",
				properties: { provisioningState: "SUCCEEDED" },
			}),
		);
		expect(outcome.diagnostics.join(" ")).not.toContain("NOT confirmed");
	});

	it.each([
		"Failed",
		"Canceled",
		"Cancelled",
	])("refuses a terminal %s", async (state) => {
		// `Cancelled` and `Canceled` both appear in the wild, and a resolver
		// that knew only one spelling would read the other as still running
		// and eventually report it as merely unconfirmed.
		expect(
			await codeOf(() =>
				createCache(
					json(200, {
						name: "thing",
						properties: { provisioningState: state },
						error: { code: "QuotaExceeded", message: "no capacity" },
					}),
				),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});

	it("quotes the failure detail", async () => {
		expect(
			await messageOf(() =>
				createCache(
					json(200, {
						name: "thing",
						properties: { provisioningState: "Failed" },
						error: { code: "QuotaExceeded", message: "no capacity" },
					}),
				),
			),
		).toContain("no capacity");
	});

	it("polls the resource itself when ARM offers no operation url", async () => {
		// The resource is the only handle there is; giving up instead would
		// report every slow create as unconfirmed.
		const outcome = await createCache(
			json(200, {
				name: "thing",
				properties: { provisioningState: "Creating" },
			}),
			json(200, {
				name: "thing",
				properties: { provisioningState: "Succeeded" },
			}),
		);
		expect(outcome.diagnostics.join(" ")).not.toContain("NOT confirmed");
	});

	it("says a 202 with no operation header is not confirmed", async () => {
		// There is nothing to follow. Reporting a finished create here is the
		// exact failure this machinery exists to prevent.
		const outcome = await createCache(raw(202, ""));
		expect(outcome.diagnostics.join(" ")).toContain("NOT confirmed complete");
		expect(outcome.diagnostics.join(" ")).toContain("no operation to follow");
	});

	it("tells the operator not to treat an unconfirmed write as a create", async () => {
		const outcome = await createCache(raw(202, ""));
		expect(outcome.diagnostics.join(" ")).toContain(
			"do not treat this outcome as a finished create",
		);
	});

	it("refuses to follow an operation url off the allowlisted surface", async () => {
		// ARM hands back a URL to poll with the bearer token attached. Following
		// one that points somewhere else would send an ARM token to a host of
		// somebody else's choosing.
		const outcome = await createCache(
			raw(202, "", { "azure-asyncoperation": "https://evil.example.com/op" }),
		);
		expect(outcome.diagnostics.join(" ")).toContain("outside the allowlisted");
	});

	it("follows Azure-AsyncOperation to a success", async () => {
		const outcome = await createCache(
			raw(202, "", { "azure-asyncoperation": OPERATION_URL }),
			json(200, { status: "Succeeded" }),
			json(200, {
				name: "thing",
				properties: { provisioningState: "Succeeded" },
			}),
		);
		expect(outcome.diagnostics.join(" ")).not.toContain("NOT confirmed");
	});

	it("refuses when the async operation reports a failure", async () => {
		expect(
			await codeOf(() =>
				createCache(
					raw(202, "", { "azure-asyncoperation": OPERATION_URL }),
					json(200, {
						status: "Failed",
						error: { code: "QuotaExceeded", message: "no capacity" },
					}),
				),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});

	it("refuses an async-operation document with no status", async () => {
		// Whether the write landed is then unknown, and unknown is refused rather
		// than assumed either way.
		expect(
			await codeOf(() =>
				createCache(
					raw(202, "", { "azure-asyncoperation": OPERATION_URL }),
					json(200, { note: "no status here" }),
				),
			),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("keeps polling a Location that still answers 202", async () => {
		// A Location poll answers 202 while the work is running and the resource
		// once it is done; treating the 202 as a body would fail to parse a
		// document that was never sent.
		const outcome = await createCache(
			raw(202, "", { location: OPERATION_URL }),
			raw(202, ""),
			json(200, {
				name: "thing",
				properties: { provisioningState: "Succeeded" },
			}),
		);
		expect(outcome.diagnostics.join(" ")).not.toContain("NOT confirmed");
	});

	it("reports running out of budget rather than swallowing it", async () => {
		const outcome = await resolverFor(AZURE_REDIS_CACHE_PRODUCT_ID, {
			pollBudget: 2,
		}).reconcile(
			request({
				productId: AZURE_REDIS_CACHE_PRODUCT_ID,
				desired: { location: "eastus", skuName: "Basic", capacity: 1 },
			}),
			sequence(
				raw(404, ""),
				raw(202, "", { "azure-asyncoperation": OPERATION_URL }),
				json(200, { status: "Running" }),
			),
		);
		expect(outcome.diagnostics.join(" ")).toContain("2-poll budget");
	});

	it("spaces polls with the injected wait", async () => {
		// Injected because a resolver may not read a clock: the default resolves
		// immediately, which is what keeps tests deterministic, and a host that
		// wants real backoff supplies it here.
		const attempts: number[] = [];
		await resolverFor(AZURE_REDIS_CACHE_PRODUCT_ID, {
			pollBudget: 2,
			waitBetweenPolls: async (attempt) => {
				attempts.push(attempt);
			},
		}).reconcile(
			request({
				productId: AZURE_REDIS_CACHE_PRODUCT_ID,
				desired: { location: "eastus", skuName: "Basic", capacity: 1 },
			}),
			sequence(
				raw(404, ""),
				raw(202, "", { "azure-asyncoperation": OPERATION_URL }),
				json(200, { status: "Running" }),
			),
		);
		expect(attempts).toEqual([1, 2]);
	});

	it("finds the operation header whatever its casing", async () => {
		// HTTP header names are not case-significant, and ARM's casing has not
		// been consistent across API versions.
		const outcome = await createCache(
			raw(202, "", { "Azure-AsyncOperation": OPERATION_URL }),
			json(200, { status: "Succeeded" }),
			json(200, {
				name: "thing",
				properties: { provisioningState: "Succeeded" },
			}),
		);
		expect(outcome.diagnostics.join(" ")).not.toContain("NOT confirmed");
	});
});

describe("required desired fields", () => {
	function reconcileCache(desired: Rec) {
		return resolverFor(AZURE_REDIS_CACHE_PRODUCT_ID).reconcile(
			request({ productId: AZURE_REDIS_CACHE_PRODUCT_ID, desired }),
			sequence(raw(404, ""), json(201, { name: "thing" })),
		);
	}

	it("refuses a create with no location", async () => {
		// There is no safe default region: a resource placed in an unrequested
		// one is a residency decision this resolver may not take.
		expect(await codeOf(() => reconcileCache({ skuName: "Basic" }))).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
	});

	it("refuses a create with no sku", async () => {
		// Every Azure Cache tier is billed and they differ by an order of
		// magnitude, so no tier is chosen here.
		expect(await codeOf(() => reconcileCache({ location: "eastus" }))).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
	});

	it("names the tiers it will accept", async () => {
		expect(
			await messageOf(() => reconcileCache({ location: "eastus" })),
		).toContain('"Basic", "Standard" or "Premium"');
	});

	it("says it never invents one", async () => {
		expect(
			await messageOf(() => reconcileCache({ skuName: "Basic" })),
		).toContain("this resolver never invents one");
	});

	it("defaults the capacity visibly rather than refusing", async () => {
		// The caller already chose the tier, and 0 is that tier's documented
		// floor — so unlike the tier itself, this one has a safe default. It is
		// still stated, because a size nobody chose is still a size somebody
		// pays for.
		const outcome = await reconcileCache({
			location: "eastus",
			skuName: "Basic",
		});
		expect(outcome.diagnostics.join(" ")).toContain(
			"capacity was not declared",
		);
	});

	it("says nothing about capacity when it was declared", async () => {
		// A diagnostic on a request that got exactly what it asked for trains
		// operators to ignore diagnostics.
		const outcome = await reconcileCache({
			location: "eastus",
			skuName: "Basic",
			capacity: 2,
		});
		expect(outcome.diagnostics.join(" ")).not.toContain("capacity was not");
	});
});

describe("Container Apps desired shapes", () => {
	const ENVIRONMENT = `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.App/managedEnvironments/env-1`;
	const APP_ID = `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.App/containerApps/thing`;
	function appJson(status: number, body: Rec): TransportResponse {
		return json(status, { id: APP_ID, ...body });
	}

	const IMAGE = "ghcr.io/hobo/app:sha256-abc";

	function appRequest(desired: Rec) {
		return request({
			productId: AZURE_CONTAINER_APPS_PRODUCT_ID,
			slot: "service",
			desired,
		});
	}

	function reconcileApp(desired: Rec, transport?: HttpTransport) {
		return resolverFor(AZURE_CONTAINER_APPS_PRODUCT_ID).reconcile(
			appRequest(desired),
			transport ?? sequence(raw(404, ""), appJson(201, { name: "thing" })),
		);
	}

	function readApp(desired: Rec, transport: HttpTransport) {
		return resolverFor(AZURE_CONTAINER_APPS_PRODUCT_ID).read(
			appRequest(desired),
			transport,
		);
	}

	const complete = {
		image: IMAGE,
		location: "eastus",
		managedEnvironmentId: ENVIRONMENT,
	};

	it("refuses a create with no image", async () => {
		// A Container App revision *is* its image; ARM refuses a template
		// without one, and guessing would deploy code nobody chose.
		expect(await codeOf(() => reconcileApp({ location: "eastus" }))).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
	});

	it("refuses a create with no location", async () => {
		expect(await codeOf(() => reconcileApp({ image: IMAGE }))).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
	});

	it("refuses a create with no managed environment", async () => {
		// An app runs inside one, and this resolver never creates one on the
		// caller's behalf — a managed environment is a billed, long-lived,
		// network-attached resource that somebody should choose deliberately.
		expect(
			await codeOf(() => reconcileApp({ image: IMAGE, location: "eastus" })),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it.each([
		["cpu without memory", { cpu: 0.5 }],
		["memory without cpu", { memory: "1Gi" }],
	])("refuses %s", async (_label, half) => {
		// Container Apps only accepts a matched pair, and ARM refuses the
		// half-declared form — with a message about the template rather than
		// about the two fields the operator actually wrote.
		expect(await codeOf(() => reconcileApp({ ...complete, ...half }))).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
	});

	it("accepts a matched cpu and memory pair", async () => {
		const outcome = await reconcileApp({
			...complete,
			cpu: 0.5,
			memory: "1Gi",
		});
		expect(outcome.action).toBe("create");
	});

	it("refuses an ingress it does not recognise", async () => {
		expect(
			await codeOf(() => reconcileApp({ ...complete, ingress: "public" })),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("names the ingress values it accepts", async () => {
		expect(
			await messageOf(() => reconcileApp({ ...complete, ingress: "public" })),
		).toContain("external, internal, none");
	});

	it.each([
		"external",
		"internal",
	])("requires a targetPort when ingress is %s", async (ingress) => {
		// ARM refuses an ingress without one, and guessing a port would
		// publish the wrong thing — potentially a debug port to the internet.
		expect(await codeOf(() => reconcileApp({ ...complete, ingress }))).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
	});

	it("does not require a targetPort for ingress none", async () => {
		// There is nothing to publish, so there is nothing to point at.
		const outcome = await reconcileApp({ ...complete, ingress: "none" });
		expect(outcome.action).toBe("create");
	});

	it("accepts an ingress with a port", async () => {
		const outcome = await reconcileApp({
			...complete,
			ingress: "external",
			targetPort: 8080,
		});
		expect(outcome.action).toBe("create");
	});

	it("leaves an app alone when it already runs the declared shape", async () => {
		// A PATCH here would create a new revision and restart the app for no
		// change at all.
		const outcome = await reconcileApp(
			complete,
			always(
				appJson(200, {
					name: "thing",
					location: "eastus",
					properties: {
						managedEnvironmentId: ENVIRONMENT,
						template: { containers: [{ image: IMAGE, name: "thing" }] },
					},
				}),
			),
		);
		expect(outcome.action).toBe("adopt");
	});

	it("patches an app whose image drifted", async () => {
		const outcome = await reconcileApp(
			complete,
			sequence(
				appJson(200, {
					name: "thing",
					properties: {
						template: { containers: [{ image: "old:1", name: "thing" }] },
					},
				}),
				appJson(200, { name: "thing" }),
			),
		);
		expect(outcome.action).toBe("update");
	});

	it.each([
		["cpu", { cpu: 0.5, memory: "1Gi" }, { cpu: 0.25, memory: "1Gi" }],
		["memory", { cpu: 0.5, memory: "1Gi" }, { cpu: 0.5, memory: "2Gi" }],
	])("patches an app whose %s drifted", async (_label, wanted, observedResources) => {
		const outcome = await reconcileApp(
			{ ...complete, ...wanted },
			sequence(
				appJson(200, {
					name: "thing",
					properties: {
						template: {
							containers: [
								{ image: IMAGE, name: "thing", resources: observedResources },
							],
						},
					},
				}),
				appJson(200, { name: "thing" }),
			),
		);
		expect(outcome.action).toBe("update");
	});

	it.each([
		"minReplicas",
		"maxReplicas",
	])("patches an app whose %s drifted", async (key) => {
		// A replica count nobody applied is a capacity ceiling nobody has.
		const outcome = await reconcileApp(
			{ ...complete, [key]: 3 },
			sequence(
				appJson(200, {
					name: "thing",
					properties: {
						template: {
							containers: [{ image: IMAGE, name: "thing" }],
							scale: { [key]: 1 },
						},
					},
				}),
				appJson(200, { name: "thing" }),
			),
		);
		expect(outcome.action).toBe("update");
	});

	it("reports a managed-environment move rather than making one", async () => {
		// Moving a Container App between environments is a delete-and-recreate,
		// so "converging" it would take the app down and give it a new address.
		const outcome = await readApp(
			{ managedEnvironmentId: ENVIRONMENT },
			always(
				appJson(200, {
					name: "thing",
					properties: { managedEnvironmentId: `${ENVIRONMENT}-other` },
				}),
			),
		);
		expect(outcome?.diagnostics.join(" ")).toContain("delete-and-recreate");
	});

	it("compares environment ids case-insensitively", async () => {
		// ARM resource ids round-trip with inconsistent casing on the provider
		// and type segments; reporting drift for that would fire on every
		// reconcile of an app that never moved.
		const outcome = await readApp(
			{ managedEnvironmentId: ENVIRONMENT.toUpperCase() },
			always(
				appJson(200, {
					name: "thing",
					properties: { managedEnvironmentId: ENVIRONMENT },
				}),
			),
		);
		expect(outcome?.diagnostics).toEqual([]);
	});

	it("reports location drift rather than correcting it", async () => {
		const outcome = await readApp(
			{ location: "westus" },
			always(appJson(200, { name: "thing", location: "eastus" })),
		);
		expect(outcome?.diagnostics.join(" ")).toContain("immutable");
	});

	it("publishes the fqdn a caller needs to reach the app", async () => {
		const outcome = await readApp(
			{},
			always(
				appJson(200, {
					name: "thing",
					properties: {
						provisioningState: "Succeeded",
						latestRevisionName: "thing--rev1",
						configuration: {
							ingress: { fqdn: "thing.eastus.azurecontainerapps.io" },
						},
					},
				}),
			),
		);
		expect(outcome?.outputs).toMatchObject({
			fqdn: "thing.eastus.azurecontainerapps.io",
			latestRevisionName: "thing--rev1",
			provisioningState: "Succeeded",
		});
	});

	it("omits app fields ARM did not send", async () => {
		// Publishing `fqdn: undefined` would make a binding believe it has an
		// address to route to.
		const outcome = await readApp({}, always(appJson(200, { name: "thing" })));
		expect(outcome?.outputs).toMatchObject({
			appName: "thing",
			ready: false,
			operationConfirmed: false,
		});
	});
});

describe("naming", () => {
	it("prefers the product's own name key over the generic one", async () => {
		// The cache spec names `cacheName` first; a wrapper that only ever read
		// `name` would address a different cache than the binding declared.
		const outcome = await resolverFor(AZURE_REDIS_CACHE_PRODUCT_ID).read(
			request({
				productId: AZURE_REDIS_CACHE_PRODUCT_ID,
				desired: { cacheName: "chosen", name: "ignored" },
			}),
			always(json(200, { name: "chosen" })),
		);
		expect(String(outcome?.physicalId)).toContain("chosen");
	});

	it("falls back to the generic name key", async () => {
		const outcome = await resolverFor(AZURE_REDIS_CACHE_PRODUCT_ID).read(
			request({
				productId: AZURE_REDIS_CACHE_PRODUCT_ID,
				desired: { name: "by-name" },
			}),
			always(json(200, { name: "by-name" })),
		);
		expect(String(outcome?.physicalId)).toContain("by-name");
	});

	it("falls back to the logical id", async () => {
		// The name is what makes reconcile convergent, so there is always one.
		const outcome = await resolverFor(AZURE_REDIS_CACHE_PRODUCT_ID).read(
			request({
				productId: AZURE_REDIS_CACHE_PRODUCT_ID,
				logicalId: "logical",
			}),
			always(json(200, { name: "logical" })),
		);
		expect(String(outcome?.physicalId)).toContain("logical");
	});
});

describe("routing", () => {
	it("refuses a request for another product", async () => {
		// Picking a resolver by hand and handing it the wrong request would send
		// a container's desired shape down the cache create path.
		expect(
			await codeOf(() =>
				resolverFor(AZURE_REDIS_CACHE_PRODUCT_ID).read(
					request({ productId: AZURE_BLOB_STORAGE_PRODUCT_ID }),
					always(raw(404, "")),
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("has no resolver for a product id nobody registered", () => {
		expect(
			azureResolverRegistry(options()).get("azure:nonesuch"),
		).toBeUndefined();
	});
});

describe("adopt versus noop", () => {
	it("adopts a cache the request did not know about", async () => {
		// Adopting something unmanaged is a fact an operator should see in the
		// audit record, not something folded into "nothing happened".
		const outcome = await resolverFor(AZURE_REDIS_CACHE_PRODUCT_ID).read(
			request({ productId: AZURE_REDIS_CACHE_PRODUCT_ID }),
			always(json(200, { name: "thing" })),
		);
		expect(outcome?.action).toBe("adopt");
	});

	it("reports noop when the caller already named the physical id", async () => {
		const outcome = await resolverFor(AZURE_REDIS_CACHE_PRODUCT_ID).read(
			request({
				productId: AZURE_REDIS_CACHE_PRODUCT_ID,
				physicalId: `/subscriptions/${SUBSCRIPTION_ID}/x`,
			}),
			always(json(200, { name: "thing" })),
		);
		expect(outcome?.action).toBe("noop");
	});

	it("reports a missing cache as absent", async () => {
		expect(
			await resolverFor(AZURE_REDIS_CACHE_PRODUCT_ID).read(
				request({ productId: AZURE_REDIS_CACHE_PRODUCT_ID }),
				always(raw(404, "")),
			),
		).toBeUndefined();
	});
});

describe("deletes", () => {
	function deleteCache(...responses: readonly TransportResponse[]) {
		return resolverFor(AZURE_REDIS_CACHE_PRODUCT_ID, {
			pollBudget: 2,
		}).delete(
			request({ productId: AZURE_REDIS_CACHE_PRODUCT_ID }),
			sequence(...responses),
		);
	}

	it("treats a 404 as already gone", async () => {
		// Two reconciles racing is normal, and absence is the goal state.
		await expect(deleteCache(raw(404, ""))).resolves.toBeUndefined();
	});

	it("confirms a 204 delete with an absent resource read", async () => {
		await expect(
			deleteCache(raw(204, ""), raw(404, "")),
		).resolves.toBeUndefined();
	});

	it("follows a long-running delete to completion", async () => {
		await expect(
			deleteCache(
				raw(202, "", { "azure-asyncoperation": OPERATION_URL }),
				json(200, { status: "Succeeded" }),
				raw(404, ""),
			),
		).resolves.toBeUndefined();
	});

	it("raises rather than returning when a delete is unconfirmed", async () => {
		// `delete()` returns void and has no diagnostics channel, so raising is
		// the only way to stop a caller reading an unfinished delete as a
		// finished one.
		expect(
			await codeOf(() =>
				deleteCache(
					raw(202, "", { "azure-asyncoperation": OPERATION_URL }),
					json(200, { status: "Running" }),
				),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});

	it("says the resource may still exist and that re-running converges", async () => {
		const message = await messageOf(() =>
			deleteCache(
				raw(202, "", { "azure-asyncoperation": OPERATION_URL }),
				json(200, { status: "Running" }),
			),
		);
		expect(message).toContain("the resource may still exist");
		expect(message).toContain("re-run delete to converge");
	});

	it("still refuses a delete ARM rejected outright", async () => {
		expect(
			await codeOf(() =>
				deleteCache(json(403, { error: { code: "AuthorizationFailed" } })),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});
});
