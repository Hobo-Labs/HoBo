/**
 * Consumer PACT for the npm registry boundary. Two directions are checked:
 * every request the realizer emits across the full lifecycle (OIDC exchange,
 * publish, promote, observe, deprecate) is declared by an interaction, and
 * every interaction is exercised; the recorded responses are parsed by the
 * realizer exactly as served.
 */
import { readFileSync } from "node:fs";
import type { HttpTransport, TransportRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	NPM_PACKAGE_VERSION_PRODUCT_ID,
	NpmOtpRequiredError,
	NpmVersionConflictError,
	npmResolverRegistry,
} from "../src/index.js";
import { isJsonObject, isJsonString, type JsonValue } from "../src/json.js";
import {
	digestOf,
	ID_TOKEN,
	memoryStore,
	options,
	PUBLISH_TOKEN,
	publishedPackument,
	registryWorld,
	request,
	TARBALL,
	UNSCOPED_NAME,
	UNSCOPED_TARBALL,
} from "./support/world.js";

interface Interaction {
	readonly description: string;
	readonly request: {
		readonly method: string;
		readonly path: string;
		readonly query?: string;
		readonly headers: Record<string, string>;
		readonly body?: JsonValue;
	};
	readonly response: {
		readonly status: number;
		readonly headers: Record<string, string>;
		readonly body: JsonValue;
	};
}

// SAFETY: the pact is a checked-in document of this shape; the first test pins its identity.
const pact = JSON.parse(
	readFileSync(
		new URL("../contracts/provider-npm-registry.pact.json", import.meta.url),
		"utf8",
	),
) as {
	consumer: { name: string };
	provider: { name: string };
	interactions: Interaction[];
};

function keySet(value: JsonValue | undefined): string[] {
	if (isJsonObject(value)) return Object.keys(value).sort();
	return [isJsonString(value) ? "string" : "other"];
}

function matches(interaction: Interaction, request: TransportRequest): boolean {
	const url = new URL(request.url);
	if (interaction.request.method !== request.method) return false;
	if (interaction.request.path !== url.pathname) return false;
	if ((interaction.request.query ?? "") !== url.search.replace(/^\?/u, ""))
		return false;
	for (const name of Object.keys(interaction.request.headers))
		if (!(name in request.headers)) return false;
	if (interaction.request.body === undefined) return request.body === undefined;
	const body: unknown = JSON.parse(request.body ?? "null");
	return (
		JSON.stringify(keySet(body)) ===
		JSON.stringify(keySet(interaction.request.body))
	);
}

function recorded(description: string): Interaction {
	const found = pact.interactions.find(
		(entry) => entry.description === description,
	);
	if (!found) throw new Error(`pact has no interaction ${description}`);
	return found;
}

/**
 * A transport that serves the named interactions in order, each exactly as
 * recorded (status, headers, body), and refuses any request the next one does
 * not declare.
 */
function replay(...descriptions: string[]): HttpTransport {
	const queue = descriptions.map(recorded);
	return async (entry) => {
		const next = queue.shift();
		if (!next || !matches(next, entry))
			throw new Error(`replay: ${entry.method} ${entry.url} is not next`);
		return {
			status: next.response.status,
			headers: next.response.headers,
			body: JSON.stringify(next.response.body),
		};
	};
}

function resolver() {
	return npmResolverRegistry(options(memoryStore(TARBALL))).get(
		NPM_PACKAGE_VERSION_PRODUCT_ID,
	);
}

async function refused(promise: Promise<unknown> | undefined) {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected a refusal");
}

const NEVER_PUBLISHED = "observe a package that has never been published";
const PUBLISH = "publish version 1.2.3 with an explicit dist-tag";
const UNCACHED =
	"read the writable packument uncached (before deprecating, and to confirm any mutation)";

describe("npm registry consumer pact", () => {
	it("names the consumer and provider", () => {
		expect(pact.consumer.name).toBe("HoBoCdReconciler");
		expect(pact.provider.name).toBe("NpmCompatibleRegistry");
	});

	it("declares every request of the full lifecycle, and the lifecycle exercises every interaction", async () => {
		const seen: TransportRequest[] = [];
		const record = (world: ReturnType<typeof registryWorld>) => {
			const transport: HttpTransport = async (entry) => {
				seen.push(entry);
				return world.transport(entry);
			};
			return transport;
		};
		const token = npmResolverRegistry(options(memoryStore(TARBALL))).get(
			NPM_PACKAGE_VERSION_PRODUCT_ID,
		);
		const oidc = npmResolverRegistry(
			options(memoryStore(UNSCOPED_TARBALL), {
				auth: "oidc-trusted-publishing",
				resolveCredential: async () => ID_TOKEN,
			}),
		).get(NPM_PACKAGE_VERSION_PRODUCT_ID);
		const fresh = registryWorld();
		await token?.reconcile(request(), record(fresh));
		await token?.reconcile(request({ distTag: "stable" }), record(fresh));
		await token?.delete(request(), record(fresh));
		await oidc?.read?.(
			request({
				packageName: UNSCOPED_NAME,
				artifactDigest: digestOf(UNSCOPED_TARBALL),
			}),
			record(
				registryWorld({
					bearer: PUBLISH_TOKEN,
					idToken: ID_TOKEN,
					name: UNSCOPED_NAME,
					packument: publishedPackument(
						UNSCOPED_TARBALL,
						{ candidate: "1.2.3" },
						"1.2.3",
						UNSCOPED_NAME,
					),
				}),
			),
		);
		for (const entry of seen)
			expect(
				pact.interactions.some((interaction) => matches(interaction, entry)),
				`${entry.method} ${entry.url} is not declared by the pact`,
			).toBe(true);
		for (const interaction of pact.interactions)
			expect(
				seen.some((entry) => matches(interaction, entry)),
				`interaction "${interaction.description}" is never exercised`,
			).toBe(true);
	});

	it("parses the recorded packument as the converged fixture version", async () => {
		const outcome = await resolver()?.read?.(
			request(),
			replay("observe the published version and its dist-tags"),
		);
		expect(outcome?.outputs).toMatchObject({
			ready: true,
			distTagVersion: "1.2.3",
		});
	});

	it("records the registry's response headers on every interaction", () => {
		for (const { description, request: sent, response } of pact.interactions) {
			expect(response.headers["content-type"], description).toBe(
				"application/json",
			);
			if (sent.method === "GET" && response.status === 200) {
				expect(response.headers["cache-control"], description).toBe(
					"public, max-age=300",
				);
				expect(response.headers.etag, description).toBeTruthy();
				expect(response.headers["cf-cache-status"], description).toBe(
					sent.query === "write=true" ? "DYNAMIC" : "HIT",
				);
			}
			if (response.status === 401)
				expect(response.headers["www-authenticate"], description).toBeTruthy();
		}
	});

	it("maps the recorded 401 Basic, Bearer challenge to a credential refusal", async () => {
		const error = await refused(
			resolver()?.reconcile(
				request(),
				replay(
					NEVER_PUBLISHED,
					"publish refused: the token is invalid or lacks publish rights (401 Basic, Bearer challenge)",
				),
			),
		);
		expect(error).toMatchObject({ code: "RESOLVER_CREDENTIAL_MISSING" });
		expect(error).not.toBeInstanceOf(NpmOtpRequiredError);
	});

	it("maps the recorded 401 OTP challenge to the 2FA refusal", async () => {
		const error = await refused(
			resolver()?.reconcile(
				request(),
				replay(
					NEVER_PUBLISHED,
					"publish refused: the account enforces 2FA on writes (401 OTP challenge)",
				),
			),
		);
		expect(error).toBeInstanceOf(NpmOtpRequiredError);
	});

	it("resolves the recorded 403 'cannot publish over' by the uncached read that shows our bytes", async () => {
		const outcome = await resolver()?.reconcile(
			request({ distTag: "latest" }),
			replay(
				NEVER_PUBLISHED,
				"publish refused: the version already exists (403 cannot publish over)",
				UNCACHED,
			),
		);
		expect(outcome?.outputs).toMatchObject({ ready: true, distTag: "latest" });
		expect(outcome?.physicalId).toBe("@hobo-fixtures/widget@1.2.3");
	});

	it("refuses a version listed by the recorded wholly-unpublished packument as previously unpublished", async () => {
		const error = await refused(
			resolver()?.reconcile(
				request(),
				replay("observe a package unpublished in its entirety"),
			),
		);
		expect(error).toBeInstanceOf(NpmVersionConflictError);
		expect(error).toMatchObject({
			reason: "npm-version-previously-unpublished",
		});
	});

	it("records the fixture tarball's real integrity in the publish document", () => {
		const publish = recorded(PUBLISH);
		// SAFETY: the publish interaction body is the npm publish document shape.
		const body = publish.request.body as {
			versions: Record<string, { dist: { integrity: string } }>;
			_attachments: Record<string, { length: number }>;
		};
		// SAFETY: the observe interaction body is an npm packument.
		const served = recorded("observe the published version and its dist-tags")
			.response.body as {
			versions: Record<string, { dist: { integrity: string } }>;
		};
		expect(body.versions["1.2.3"]?.dist.integrity).toBe(
			served.versions["1.2.3"]?.dist.integrity,
		);
		expect(body._attachments["@hobo-fixtures/widget-1.2.3.tgz"]?.length).toBe(
			TARBALL.byteLength,
		);
	});
});
