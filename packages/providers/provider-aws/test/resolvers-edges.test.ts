/**
 * AWS resolver edges — the shared plumbing under every product.
 *
 * The suite next door drives the happy shapes. This file drives the wrapper and
 * the two body readers: credentials, redaction, the bounded XML scanner, the
 * JSON and XML refusal paths, and the adopt/noop distinction. All seven
 * resolvers inherit them, so a defect here is a defect seven times over — and
 * each of these paths runs exactly when something has already gone wrong.
 *
 * Three properties do most of the work:
 *
 * **Resolved material never survives into text.** AWS error bodies echo request
 * context and have carried an access key id. Redaction removes the resolved
 * material by exact match *first* — that is the part that must never survive —
 * and only then scrubs anything else token-shaped. A resolver that redacted
 * only by pattern would depend on the pattern being right about a secret it was
 * handed and could have matched exactly.
 *
 * **The XML reader is bounded and deliberately incomplete.** It is a forward
 * `indexOf` scan: no regex, so no catastrophic backtracking on a hostile body,
 * and no recursion, so no stack growth with nesting depth. It also must not
 * confuse `<Code>` with `<CodeSigningConfig>`, which is exactly the kind of
 * prefix collision a naive `indexOf` gets wrong and which would make an error
 * code read as something else entirely.
 *
 * **An unknown outcome is refused, never assumed.** A body this code cannot
 * parse leaves the effect of the call unknown, and both ways of guessing are
 * worse than a typed refusal.
 *
 * Everything runs through an injected fake transport and an injected clock. No
 * network, no credential, no AWS account.
 */

import type {
	AwsCredentials,
	HttpTransport,
	ResolveRequest,
	ResourceResolver,
	TransportResponse,
} from "@hobo/core";
import { parseResolveRequest, ResolverError } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	AWS_DYNAMODB_PRODUCT_ID,
	AWS_S3_PRODUCT_ID,
	AWS_SQS_PRODUCT_ID,
	type AwsResolverOptions,
	awsResolverRegistry,
	redactAwsText,
} from "../src/index.js";

import type { JsonObject, JsonValue } from "../src/json.js";

const CREDENTIAL_REF = "secret://camp/aws-deploy";
const NOW_MS = Date.parse("2026-08-19T12:00:00.000Z");
const CREDENTIALS: AwsCredentials = Object.freeze({
	accessKeyId: "AKIAFAKEACCESSKEYID12",
	secretAccessKey: "fake-secret-access-key-0123456789abcdefghij",
});

function options(
	overrides: Partial<AwsResolverOptions> = {},
): AwsResolverOptions {
	return {
		region: "us-east-1",
		resolveCredential: async () => CREDENTIALS,
		nowMs: NOW_MS,
		...overrides,
	};
}

function resolverFor(
	productId: string,
	overrides: Partial<AwsResolverOptions> = {},
): ResourceResolver {
	const resolver = awsResolverRegistry(options(overrides)).get(productId);
	if (resolver === undefined) {
		throw new Error(`no resolver registered for ${productId}`);
	}
	return resolver;
}

function request(input: {
	readonly productId: string;
	readonly logicalId?: string;
	readonly physicalId?: string;
	readonly desired?: JsonObject;
	readonly credentialRef?: string;
}): ResolveRequest {
	const ref = {
		slot: "bucket",
		productId: input.productId,
		logicalId: input.logicalId ?? "thing",
	};
	if (input.physicalId !== undefined)
		Object.assign(ref, { physicalId: input.physicalId });
	return parseResolveRequest({
		ref,
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
		headers: { "content-type": "application/x-amz-json-1.0" },
		body: JSON.stringify(payload),
	};
}

function raw(status: number, body: string): TransportResponse {
	return { status, headers: {}, body };
}

async function codeOf<T>(run: () => Promise<T>): Promise<string> {
	try {
		await run();
	} catch (error) {
		return error instanceof ResolverError ? error.code : "NO_CODE";
	}
	return "NO_ERROR_THROWN";
}

async function messageOf<T>(run: () => Promise<T>): Promise<string> {
	try {
		await run();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "NO_ERROR_THROWN";
}

/** An S3 read — the shortest path to the XML side of the wrapper. */
function readS3(
	transport: HttpTransport,
	overrides: Partial<AwsResolverOptions> = {},
	input: Partial<Parameters<typeof request>[0]> = {},
) {
	return resolverFor(AWS_S3_PRODUCT_ID, overrides).read(
		request({ productId: AWS_S3_PRODUCT_ID, ...input }),
		transport,
	);
}

/** A DynamoDB read — the shortest path to the JSON side of the wrapper. */
function readDynamo(
	transport: HttpTransport,
	overrides: Partial<AwsResolverOptions> = {},
	input: Partial<Parameters<typeof request>[0]> = {},
) {
	return resolverFor(AWS_DYNAMODB_PRODUCT_ID, overrides).read(
		request({ productId: AWS_DYNAMODB_PRODUCT_ID, ...input }),
		transport,
	);
}

// ---------------------------------------------------------------------------

describe("redaction", () => {
	it("removes the resolved secret by exact match", () => {
		// The pattern scrub is a backstop. Removing the material this resolver was
		// actually handed is the part that must not depend on a regex being right
		// about the shape of somebody's key.
		expect(
			redactAwsText(
				`signature used ${CREDENTIALS.secretAccessKey}`,
				CREDENTIALS,
			),
		).not.toContain(CREDENTIALS.secretAccessKey);
	});

	it("removes the access key id", () => {
		expect(
			redactAwsText(`key ${CREDENTIALS.accessKeyId} denied`, CREDENTIALS),
		).not.toContain(CREDENTIALS.accessKeyId);
	});

	it("removes a session token when there is one", () => {
		// A session token is the longest-lived thing in the triple that still
		// grants access, and AWS quotes it back in some STS errors.
		const withSession: AwsCredentials = {
			...CREDENTIALS,
			sessionToken: "FAKESESSIONTOKEN0123456789abcdefghijklmnop",
		};
		expect(
			redactAwsText(`token ${withSession.sessionToken}`, withSession),
		).not.toContain(withSession.sessionToken);
	});

	it("ignores material too short to be meaningful", () => {
		// Splitting on a one- or two-character "secret" would shred every message
		// into redaction markers and destroy the diagnostic entirely.
		expect(
			redactAwsText("size is 5 gb", {
				accessKeyId: "a",
				secretAccessKey: "b",
			}),
		).toBe("size is 5 gb");
	});

	it("still scrubs token-shaped text with no credentials to match", () => {
		// The refusal paths that run *before* a credential resolves have nothing
		// to match against, so the pattern has to carry them alone.
		expect(redactAwsText("AKIAEXAMPLEEXAMPLEEX rejected", undefined)).toContain(
			"[redacted]",
		);
	});

	it("leaves short words alone", () => {
		// Redacting ordinary prose makes provider errors unreadable, and an
		// unreadable error gets ignored rather than acted on.
		expect(redactAwsText("bucket is not empty", undefined)).toBe(
			"bucket is not empty",
		);
	});

	it("truncates long text with an ellipsis", () => {
		const scrubbed = redactAwsText("ab cd ".repeat(200), undefined, 100);
		expect(scrubbed).toHaveLength(101);
		expect(scrubbed.endsWith("…")).toBe(true);
	});

	it("does not append an ellipsis to text that fits", () => {
		expect(redactAwsText("short", undefined, 100).endsWith("…")).toBe(false);
	});
});

describe("the credential boundary", () => {
	it("refuses an empty credentialRef", async () => {
		expect(
			await codeOf(() =>
				readS3(always(raw(404, "")), {}, { credentialRef: "   " }),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("refuses a credentialRef that is really an access key id", async () => {
		// A pasted key in this field has already leaked into the event log by the
		// time anything uses it, and every request would still be signed
		// correctly — which is what makes the leak invisible without this check.
		expect(
			await codeOf(() =>
				readS3(
					always(raw(404, "")),
					{},
					{
						credentialRef: "AKIAEXAMPLEEXAMPLEEX",
					},
				),
			),
		).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
	});

	it("refuses a ref that is not a locator", async () => {
		expect(
			await codeOf(() =>
				readS3(always(raw(404, "")), {}, { credentialRef: "aws-deploy" }),
			),
		).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
	});

	it("refuses when the host's resolver throws", async () => {
		expect(
			await codeOf(() =>
				readS3(always(raw(404, "")), {
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
				readS3(always(raw(404, "")), {
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
				readS3(always(raw(404, "")), {
					resolveCredential: async () => {
						throw "sealed";
					},
				}),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it.each([
		["nothing at all", undefined],
		["a non-object", "AKIA..."],
		["no access key id", { secretAccessKey: "s" }],
		["a blank access key id", { accessKeyId: "  ", secretAccessKey: "s" }],
		["no secret", { accessKeyId: "AKIA" }],
		["a blank secret", { accessKeyId: "AKIA", secretAccessKey: " " }],
	])("refuses when the host resolves to %s", async (_label, material) => {
		// Retrying unsigned would surface at AWS as a permissions error, sending
		// the operator to look at IAM policy when the real problem is a reference
		// nobody registered.
		expect(
			await codeOf(() =>
				readS3(always(raw(404, "")), {
					resolveCredential: async () => {
						// SAFETY: Deliberately violate the typed credential boundary to verify runtime refusal of each malformed host response.
						return material as never;
					},
				}),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("refuses to build resolvers with no resolveCredential at all", () => {
		expect(() =>
			// SAFETY: Deliberately omit the required host credential resolver to verify construction fails before provider I/O.
			awsResolverRegistry(options({ resolveCredential: undefined as never })),
		).toThrow(/never reads an environment variable/u);
	});
});

describe("the signing clock", () => {
	it("accepts a number for the single-shot case", () => {
		expect(() => awsResolverRegistry(options({ nowMs: NOW_MS }))).not.toThrow();
	});

	it("accepts a function, the honest shape for a long deploy", () => {
		// A frozen number eventually falls outside AWS's signature validity
		// window, so a deploy that runs for minutes needs a live clock.
		expect(() =>
			awsResolverRegistry(options({ nowMs: () => NOW_MS })),
		).not.toThrow();
	});

	it("refuses a missing clock rather than reading the ambient one", () => {
		// A signer that reads `Date.now()` cannot be pinned by a test, and the
		// signature would silently depend on when the process happened to run.
		expect(() =>
			// SAFETY: Deliberately omit the injected signing clock to verify runtime refusal instead of reading ambient time.
			awsResolverRegistry(options({ nowMs: undefined as never })),
		).toThrow(/injected nowMs/u);
	});

	it("refuses a non-finite clock", () => {
		expect(() => awsResolverRegistry(options({ nowMs: Number.NaN }))).toThrow(
			/injected nowMs/u,
		);
	});
});

describe("the region", () => {
	it("refuses a region that is not a region", () => {
		// The region is interpolated into every endpoint host. Parsing it rather
		// than trusting it is what keeps a caller's string out of a URL.
		expect(() =>
			awsResolverRegistry(options({ region: "not a region" })),
		).toThrow();
	});

	it("refuses an empty region", () => {
		expect(() => awsResolverRegistry(options({ region: "" }))).toThrow();
	});
});

describe("routing", () => {
	it("refuses a request for another product", async () => {
		// Picking a resolver by hand and handing it the wrong request would send a
		// queue's desired shape down the bucket create path.
		expect(
			await codeOf(() =>
				resolverFor(AWS_S3_PRODUCT_ID).read(
					request({ productId: AWS_SQS_PRODUCT_ID }),
					always(raw(404, "")),
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("says to route through the registry", async () => {
		expect(
			await messageOf(() =>
				resolverFor(AWS_S3_PRODUCT_ID).read(
					request({ productId: AWS_SQS_PRODUCT_ID }),
					always(raw(404, "")),
				),
			),
		).toContain("route the request through the registry");
	});

	it("has no resolver for a product id nobody registered", () => {
		expect(awsResolverRegistry(options()).get("aws:nonesuch")).toBeUndefined();
	});
});

describe("the bounded XML reader", () => {
	// Driven through S3's refusal path, which is the only way these bodies reach
	// the scanner in production.

	function s3Refusal(body: string): Promise<string> {
		return messageOf(() => readS3(always(raw(403, body))));
	}

	it("reads the error code out of a normal body", async () => {
		expect(
			await s3Refusal("<Error><Code>AccessDenied</Code></Error>"),
		).toContain("AccessDenied");
	});

	it("reads the message out of a normal body", async () => {
		expect(
			await s3Refusal(
				"<Error><Code>AccessDenied</Code><Message>not your bucket</Message></Error>",
			),
		).toContain("not your bucket");
	});

	it("does not mistake CodeSigningConfig for Code", async () => {
		// The prefix collision a naive indexOf gets wrong. Reading
		// `CodeSigningConfig`'s text as the error code would report a completely
		// different failure than the one that happened.
		const message = await s3Refusal(
			"<Error><CodeSigningConfig>arn:aws:lambda:x</CodeSigningConfig><Message>denied</Message></Error>",
		);
		expect(message).not.toContain("arn:aws:lambda");
	});

	it("accepts an element with attributes", async () => {
		expect(
			await s3Refusal('<Error><Code xmlns="urn:x">AccessDenied</Code></Error>'),
		).toContain("AccessDenied");
	});

	it("treats a self-closing element as present and empty", async () => {
		// `<Code/>` is a code that is there and says nothing. Reporting the raw
		// body instead would dump the whole response into the message.
		const message = await s3Refusal(
			"<Error><Code/><Message>oops</Message></Error>",
		);
		expect(message).toContain("oops");
	});

	it("survives an unterminated open tag", async () => {
		// A truncated body is what a cut connection produces. The scan has to
		// stop, not loop.
		expect(await s3Refusal("<Error><Code")).toContain("status 403");
	});

	it("survives a missing close tag", async () => {
		expect(await s3Refusal("<Error><Code>AccessDenied")).toContain(
			"status 403",
		);
	});

	it("survives a body that is not XML at all", async () => {
		// An HTML error page from a proxy in front of the endpoint.
		expect(await s3Refusal("<html>gateway timeout</html>")).toContain(
			"status 403",
		);
	});

	it("survives an empty body", async () => {
		expect(await s3Refusal("")).toContain("status 403");
	});

	it("decodes the five predefined entities in a message", async () => {
		// Nothing else is decoded on purpose: a general entity expander on a
		// hostile body is a class of vulnerability this module has no use for.
		expect(
			await s3Refusal(
				"<Error><Message>bucket &lt;name&gt; &amp; key &quot;k&quot;</Message></Error>",
			),
		).toContain('bucket <name> & key "k"');
	});

	it("does not decode a numeric character reference", async () => {
		expect(
			await s3Refusal("<Error><Message>a &#65; b</Message></Error>"),
		).toContain("&#65;");
	});

	it("treats a whitespace-only element as absent", async () => {
		// An element whose text is only whitespace carries no information, and
		// reporting it as the code would print an empty parenthesis.
		expect(
			await s3Refusal("<Error><Code>   </Code><Message>oops</Message></Error>"),
		).not.toContain("(   )");
	});

	it("redacts token-shaped text inside a provider message", async () => {
		// AWS error bodies echo request context and have carried an access key id.
		expect(
			await s3Refusal(
				`<Error><Message>key ${CREDENTIALS.accessKeyId} denied</Message></Error>`,
			),
		).not.toContain(CREDENTIALS.accessKeyId);
	});
});

describe("the JSON body reader", () => {
	it("names the AWS error type without its package path", async () => {
		// `com.amazonaws.dynamodb.v20120810#ResourceNotFoundException` — only the
		// last segment identifies the error; the prefix changes between services
		// and API versions, so keying on the whole string would break on an
		// upgrade that changed nothing that matters.
		expect(
			await messageOf(() =>
				readDynamo(
					always(
						json(400, {
							__type: "com.amazonaws.dynamodb.v20120810#ValidationException",
							message: "bad key schema",
						}),
					),
				),
			),
		).toContain("(ValidationException)");
	});

	it("strips a trailing colon qualifier from the type", async () => {
		expect(
			await messageOf(() =>
				readDynamo(
					always(
						json(400, { __type: "ValidationException:extra", message: "x" }),
					),
				),
			),
		).toContain("(ValidationException)");
	});

	it("accepts `code` as well as `__type`", async () => {
		// Not every AWS JSON service uses the same key for the same fact.
		expect(
			await messageOf(() =>
				readDynamo(
					always(
						json(400, { code: "ThrottlingException", message: "slow down" }),
					),
				),
			),
		).toContain("(ThrottlingException)");
	});

	it("reads a capitalised Message as well as a lower-case one", async () => {
		expect(
			await messageOf(() =>
				readDynamo(always(json(400, { Message: "capitalised detail" }))),
			),
		).toContain("capitalised detail");
	});

	it("falls back to the raw body when there is no message", async () => {
		// Discarding it would leave the operator with only a status code.
		expect(
			await messageOf(() =>
				readDynamo(always(raw(400, "something went wrong"))),
			),
		).toContain("something went wrong");
	});

	it("omits the parenthesised code when the body names none", async () => {
		// An empty `()` in a message reads as a bug in the message rather than a
		// fact about the provider.
		expect(
			await messageOf(() => readDynamo(always(raw(500, "boom")))),
		).not.toContain("()");
	});

	it("refuses a success body that is not a JSON object", async () => {
		// The effect of the call is unknown, and both ways of guessing are worse
		// than a refusal.
		expect(
			await codeOf(() => readDynamo(always(raw(200, "<html>not json")))),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("refuses a success body that is JSON but not an object", async () => {
		expect(await codeOf(() => readDynamo(always(raw(200, "[1,2,3]"))))).toBe(
			"RESOLVER_OUTPUT_UNPARSEABLE",
		);
	});

	it("says to retry, and what a repeat would mean", async () => {
		expect(
			await messageOf(() => readDynamo(always(raw(200, "<html>not json")))),
		).toContain("the API contract has changed");
	});

	it("carries the typed code for a provider refusal", async () => {
		// The lane branches on the code; a stringly-typed failure would collapse
		// "provider said no" into "something went wrong".
		expect(await codeOf(() => readDynamo(always(raw(500, "boom"))))).toBe(
			"RESOLVER_PROVIDER_REJECTED",
		);
	});
});

describe("S3 bucket naming", () => {
	it.each([
		["an upper-case letter", "MyBucket"],
		["an underscore", "my_bucket"],
		["a single character", "a"],
		["a leading dot", ".bucket"],
		["a trailing dash", "bucket-"],
	])("refuses a name with %s", async (_label, name) => {
		// S3 would refuse these too, but with a message about the request rather
		// than about the name. Refusing here is where the message can say why.
		expect(
			await codeOf(() => readS3(always(raw(404, "")), {}, { logicalId: name })),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("quotes the grammar it applied", async () => {
		const message = await messageOf(() =>
			readS3(always(raw(404, "")), {}, { logicalId: "MyBucket" }),
		);
		expect(message).toContain("DNS-safe grammar");
	});

	it("accepts a dotted name, which S3 allows", async () => {
		expect(
			await readS3(always(raw(404, "")), {}, { logicalId: "my.bucket.name" }),
		).toBeUndefined();
	});

	it("prefers desired.name over the logical id", async () => {
		// The name is what makes reconcile convergent; a logical id shadowing an
		// explicit name would address the wrong bucket.
		expect(
			await codeOf(() =>
				readS3(
					always(raw(404, "")),
					{},
					{
						logicalId: "fine-bucket",
						desired: { name: "NOT-DNS-SAFE" },
					},
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});
});

describe("S3 reads", () => {
	const location = raw(
		200,
		"<LocationConstraint>eu-west-1</LocationConstraint>",
	);

	it("reports a missing bucket as absent", async () => {
		expect(await readS3(always(raw(404, "")))).toBeUndefined();
	});

	it("reads an empty LocationConstraint as us-east-1", async () => {
		// S3 has always reported us-east-1 that way, and a caller comparing
		// regions needs the real name rather than an empty string.
		const outcome = await readS3(
			sequence(
				raw(200, "<LocationConstraint></LocationConstraint>"),
				raw(200, "<VersioningConfiguration/>"),
				raw(404, ""),
			),
		);
		expect(outcome?.outputs.region).toBe("us-east-1");
	});

	it("publishes the reported region when there is one", async () => {
		const outcome = await readS3(
			sequence(location, raw(200, "<VersioningConfiguration/>"), raw(404, "")),
		);
		expect(outcome?.outputs.region).toBe("eu-west-1");
	});

	it("omits versioning when the bucket has never had it configured", async () => {
		// An absent status and a status of "Suspended" are different facts, and a
		// caller that saw `versioning: undefined` could not tell them apart.
		const outcome = await readS3(
			sequence(location, raw(200, "<VersioningConfiguration/>"), raw(404, "")),
		);
		expect(outcome?.outputs).not.toHaveProperty("versioning");
	});

	it("publishes versioning when it is configured", async () => {
		const outcome = await readS3(
			sequence(
				location,
				raw(
					200,
					"<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>",
				),
				raw(404, ""),
			),
		);
		expect(outcome?.outputs.versioning).toBe("Enabled");
	});

	it("treats a missing public access block as not blocked", async () => {
		// 404 NoSuchPublicAccessBlockConfiguration is the documented "not
		// configured" answer, not a failure — but "not configured" means the
		// bucket is *not* blocked, which is the answer an operator needs.
		const outcome = await readS3(
			sequence(location, raw(200, "<VersioningConfiguration/>"), raw(404, "")),
		);
		expect(outcome?.outputs.publicAccessBlocked).toBe(false);
	});

	it("reports the block when it is configured", async () => {
		const outcome = await readS3(
			sequence(
				location,
				raw(200, "<VersioningConfiguration/>"),
				raw(
					200,
					"<PublicAccessBlockConfiguration><BlockPublicAcls>true</BlockPublicAcls></PublicAccessBlockConfiguration>",
				),
			),
		);
		expect(outcome?.outputs.publicAccessBlocked).toBe(true);
	});

	it("reports not-blocked when the configuration says false", async () => {
		const outcome = await readS3(
			sequence(
				location,
				raw(200, "<VersioningConfiguration/>"),
				raw(
					200,
					"<PublicAccessBlockConfiguration><BlockPublicAcls>false</BlockPublicAcls></PublicAccessBlockConfiguration>",
				),
			),
		);
		expect(outcome?.outputs.publicAccessBlocked).toBe(false);
	});

	it("refuses when the location probe fails for a reason other than absence", async () => {
		// 403 is "this bucket exists and is not yours", which is emphatically not
		// the same as "create one".
		expect(await codeOf(() => readS3(always(raw(403, ""))))).toBe(
			"RESOLVER_PROVIDER_REJECTED",
		);
	});
});

describe("S3 reconcile", () => {
	const absent = raw(404, "");
	const created = raw(200, "");
	const noVersioning = raw(200, "<VersioningConfiguration/>");

	it("creates a bucket that is not there", async () => {
		const outcome = await resolverFor(AWS_S3_PRODUCT_ID).reconcile(
			request({ productId: AWS_S3_PRODUCT_ID }),
			sequence(absent, created),
		);
		expect(outcome.action).toBe("create");
	});

	it("reports a freshly created bucket as unblocked and unversioned", async () => {
		// The create call configures neither, so claiming otherwise would tell an
		// operator their new bucket is protected when it is not.
		const outcome = await resolverFor(AWS_S3_PRODUCT_ID).reconcile(
			request({ productId: AWS_S3_PRODUCT_ID }),
			sequence(absent, created),
		);
		expect(outcome.outputs.publicAccessBlocked).toBe(false);
		expect(outcome.outputs).not.toHaveProperty("versioning");
	});

	it("enables versioning when asked and the bucket has none", async () => {
		const outcome = await resolverFor(AWS_S3_PRODUCT_ID).reconcile(
			request({
				productId: AWS_S3_PRODUCT_ID,
				desired: { versioning: true },
			}),
			sequence(
				raw(200, "<LocationConstraint>us-east-1</LocationConstraint>"),
				noVersioning,
				absent,
				raw(200, ""),
			),
		);
		expect(outcome.action).toBe("update");
		expect(outcome.outputs.versioning).toBe("Enabled");
	});

	it("leaves versioning alone when it already matches", async () => {
		// A PUT that changes nothing still shows up in CloudTrail as a mutation
		// and still costs a request.
		const outcome = await resolverFor(AWS_S3_PRODUCT_ID).reconcile(
			request({
				productId: AWS_S3_PRODUCT_ID,
				desired: { versioning: true },
			}),
			sequence(
				raw(200, "<LocationConstraint>us-east-1</LocationConstraint>"),
				raw(
					200,
					"<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>",
				),
				absent,
			),
		);
		expect(outcome.action).toBe("adopt");
	});

	it("suspends versioning when asked to turn it off", async () => {
		// An unconfigured bucket reads as Suspended, so asking for `false` on one
		// that has never had versioning must not send a redundant PUT.
		const outcome = await resolverFor(AWS_S3_PRODUCT_ID).reconcile(
			request({
				productId: AWS_S3_PRODUCT_ID,
				desired: { versioning: false },
			}),
			sequence(
				raw(200, "<LocationConstraint>us-east-1</LocationConstraint>"),
				noVersioning,
				absent,
			),
		);
		expect(outcome.action).toBe("adopt");
	});

	it("blocks public access when asked and the bucket is open", async () => {
		const outcome = await resolverFor(AWS_S3_PRODUCT_ID).reconcile(
			request({
				productId: AWS_S3_PRODUCT_ID,
				desired: { publicAccessBlocked: true },
			}),
			sequence(
				raw(200, "<LocationConstraint>us-east-1</LocationConstraint>"),
				noVersioning,
				absent,
				raw(200, ""),
			),
		);
		expect(outcome.action).toBe("update");
		expect(outcome.outputs.publicAccessBlocked).toBe(true);
	});

	it("does not unblock a bucket that asks for publicAccessBlocked false", async () => {
		// Turning a block *off* is a one-way door into exposure. The resolver
		// only ever tightens this setting; loosening it is a deliberate act
		// somebody performs knowingly, not a side effect of a manifest edit.
		const outcome = await resolverFor(AWS_S3_PRODUCT_ID).reconcile(
			request({
				productId: AWS_S3_PRODUCT_ID,
				desired: { publicAccessBlocked: false },
			}),
			sequence(
				raw(200, "<LocationConstraint>us-east-1</LocationConstraint>"),
				noVersioning,
				raw(
					200,
					"<PublicAccessBlockConfiguration><BlockPublicAcls>true</BlockPublicAcls></PublicAccessBlockConfiguration>",
				),
			),
		);
		expect(outcome.action).toBe("adopt");
		expect(outcome.outputs.publicAccessBlocked).toBe(true);
	});

	it("counts both changes as one update on an existing bucket", async () => {
		const outcome = await resolverFor(AWS_S3_PRODUCT_ID).reconcile(
			request({
				productId: AWS_S3_PRODUCT_ID,
				desired: { versioning: true, publicAccessBlocked: true },
			}),
			sequence(
				raw(200, "<LocationConstraint>us-east-1</LocationConstraint>"),
				noVersioning,
				absent,
				raw(200, ""),
			),
		);
		expect(outcome.action).toBe("update");
	});

	it("stays a create when the settings are applied to a new bucket", async () => {
		// The bucket did not exist a moment ago; reporting `update` would tell an
		// operator's audit trail that something was already there.
		const outcome = await resolverFor(AWS_S3_PRODUCT_ID).reconcile(
			request({
				productId: AWS_S3_PRODUCT_ID,
				desired: { versioning: true, publicAccessBlocked: true },
			}),
			sequence(absent, created, raw(200, "")),
		);
		expect(outcome.action).toBe("create");
	});

	it("refuses when the create is rejected", async () => {
		expect(
			await codeOf(() =>
				resolverFor(AWS_S3_PRODUCT_ID).reconcile(
					request({ productId: AWS_S3_PRODUCT_ID }),
					sequence(
						absent,
						raw(409, "<Error><Code>BucketAlreadyExists</Code></Error>"),
					),
				),
			),
		).toBe("RESOLVER_PROVIDER_REJECTED");
	});
});

describe("DynamoDB desired shapes", () => {
	function reconcileDynamo(desired: JsonObject, transport?: HttpTransport) {
		return resolverFor(AWS_DYNAMODB_PRODUCT_ID).reconcile(
			request({ productId: AWS_DYNAMODB_PRODUCT_ID, desired }),
			transport ??
				sequence(
					json(400, { __type: "ResourceNotFoundException" }),
					json(200, {
						TableDescription: {
							TableName: "thing",
							TableArn: "arn:aws:dynamodb:us-east-1:1:table/thing",
							TableStatus: "ACTIVE",
						},
					}),
				),
		);
	}

	it.each([
		["partitionKeyType", {}],
		// The sort key type is only consulted when there *is* a sort key, so the
		// refusal needs one present to be reachable at all.
		["sortKeyType", { sortKey: "sk" }],
	])("refuses an unknown %s", async (key, extra) => {
		// A key type the API does not take fails at AWS with a validation error
		// about a request the operator never wrote.
		expect(await codeOf(() => reconcileDynamo({ ...extra, [key]: "X" }))).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
	});

	it("does not validate a sort key type with no sort key to apply it to", async () => {
		// Dead configuration, not an error: refusing it would break a manifest
		// that carries the annotation for a sort key added later.
		const outcome = await reconcileDynamo({ sortKeyType: "X" });
		expect(outcome.action).toBe("create");
	});

	it("names the types it will accept", async () => {
		expect(
			await messageOf(() => reconcileDynamo({ partitionKeyType: "X" })),
		).toContain("S | N | B");
	});

	it("defaults a key type rather than refusing", async () => {
		// String keys are the overwhelming majority, and requiring the annotation
		// would make the simplest table an error.
		const outcome = await reconcileDynamo({});
		expect(outcome.action).toBe("create");
	});

	it("refuses a billing mode it does not recognise", async () => {
		expect(await codeOf(() => reconcileDynamo({ billingMode: "free" }))).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
	});

	it("names the two billing modes", async () => {
		expect(
			await messageOf(() => reconcileDynamo({ billingMode: "free" })),
		).toContain('"on-demand" or "provisioned"');
	});

	it.each([
		["no capacities at all", {}],
		["only a read capacity", { readCapacity: 5 }],
		["only a write capacity", { writeCapacity: 5 }],
		["a zero read capacity", { readCapacity: 0, writeCapacity: 5 }],
		["a negative write capacity", { readCapacity: 5, writeCapacity: -1 }],
	])("refuses provisioned billing with %s", async (_label, capacities) => {
		// Inventing a capacity bills the account for a number nobody chose,
		// every hour, until somebody notices the line item.
		expect(
			await codeOf(() =>
				reconcileDynamo({ billingMode: "provisioned", ...capacities }),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("says why a capacity is not invented", async () => {
		expect(
			await messageOf(() => reconcileDynamo({ billingMode: "provisioned" })),
		).toContain("a number nobody chose");
	});

	it("accepts provisioned billing with both capacities", async () => {
		const outcome = await reconcileDynamo({
			billingMode: "provisioned",
			readCapacity: 5,
			writeCapacity: 5,
		});
		expect(outcome.action).toBe("create");
	});

	it("accepts on-demand billing named explicitly", async () => {
		const outcome = await reconcileDynamo({ billingMode: "on-demand" });
		expect(outcome.action).toBe("create");
	});
});

describe("adopt versus noop", () => {
	it("adopts a bucket the request did not know about", async () => {
		// Adopting something unmanaged is a fact an operator should see in the
		// audit record, not something folded into "nothing happened".
		const outcome = await readS3(
			sequence(
				raw(200, "<LocationConstraint>us-east-1</LocationConstraint>"),
				raw(200, "<VersioningConfiguration/>"),
				raw(404, ""),
			),
		);
		expect(outcome?.action).toBe("adopt");
	});

	it("reports noop when the caller already named the physical id", async () => {
		const outcome = await readS3(
			sequence(
				raw(200, "<LocationConstraint>us-east-1</LocationConstraint>"),
				raw(200, "<VersioningConfiguration/>"),
				raw(404, ""),
			),
			{},
			{ physicalId: "thing" },
		);
		expect(outcome?.action).toBe("noop");
	});
});
