// Writes the WP2 PACT files (contracts/sources.*.pact.json) from the recorded
// test fixtures, so the contract and the fixtures the driver tests replay can
// never drift. Re-run after re-recording fixtures:
//   node --import tsx packages/cd/contracts/sources.generate.ts
// contracts/sources.consumer.test.ts verifies every interaction.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitFixture } from "../test/sources/git-fixtures.js";
import { OCI_FIXTURES } from "../test/sources/oci-fixtures.js";
import { PACKAGE_FIXTURES } from "../test/sources/package-fixtures.js";
import type { Exchange } from "../test/sources/support.js";

const here = dirname(fileURLToPath(import.meta.url));

type MutableExchange = { -readonly [K in keyof Exchange]: Exchange[K] };

type Body = { content: string; contentType: string; encoded: "base64" | false };
type PactRequest = {
	method: string;
	path: string;
	headers: Readonly<Record<string, string>>;
	query?: string;
	body?: Body;
};
type PactResponse = {
	status: number;
	headers: Readonly<Record<string, string>>;
	body?: Body;
};
type PactInteraction = Readonly<{
	type: "Synchronous/HTTP";
	description: string;
	providerStates: readonly Readonly<{ name: string }>[];
	request: PactRequest;
	response: PactResponse;
}>;
type PactDocument = Readonly<{
	consumer: Readonly<{ name: string }>;
	provider: Readonly<{ name: string }>;
	metadata: Readonly<{
		pactSpecification: Readonly<{ version: string }>;
		evidence: string;
	}>;
	interactions: readonly PactInteraction[];
}>;

function body(
	text: string | undefined,
	contentType: string,
	binary: boolean,
): Body | undefined {
	if (text === undefined || text === "") return undefined;
	return binary
		? {
				content: Buffer.from(text, "latin1").toString("base64"),
				contentType,
				encoded: "base64",
			}
		: { content: text, contentType, encoded: false };
}

function interaction(
	exchange: Exchange,
	description: string,
	binary: (url: string) => boolean,
): PactInteraction {
	const url = new URL(exchange.url);
	const request: PactRequest = {
		method: exchange.method ?? "GET",
		path: url.pathname,
		headers: exchange.headers ?? {},
	};
	if (url.search) request.query = url.search.slice(1);
	const requestBody = body(
		exchange.body,
		"application/x-git-upload-pack-request",
		false,
	);
	if (requestBody) request.body = requestBody;
	const response: PactResponse = {
		status: exchange.status ?? 200,
		headers: exchange.responseHeaders ?? {},
	};
	const responseBody = body(
		exchange.response,
		binary(exchange.url) ? "application/octet-stream" : "application/json",
		binary(exchange.url),
	);
	if (responseBody) response.body = responseBody;
	return {
		type: "Synchronous/HTTP",
		description,
		providerStates: [{ name: `origin ${url.origin}` }],
		request,
		response,
	};
}

function pact(
	consumer: string,
	provider: string,
	evidence: string,
	interactions: readonly PactInteraction[],
): PactDocument {
	return {
		consumer: { name: consumer },
		provider: { name: provider },
		metadata: { pactSpecification: { version: "4.0.0" }, evidence },
		interactions,
	};
}

function write(name: string, document: PactDocument): void {
	writeFileSync(join(here, name), `${JSON.stringify(document, null, "\t")}\n`);
}

const describeExchange = (exchange: Exchange) => {
	const url = new URL(exchange.url);
	const auth = exchange.headers?.authorization ? " (authorized)" : "";
	return `${exchange.method ?? "GET"} ${url.pathname}${url.search}${auth} -> ${exchange.status ?? 200}`;
};

write(
	"sources.oci.pact.json",
	pact(
		"HoboCdOciSubscriptionDriver",
		"OciDistributionRegistry",
		"Hand-authored OCI distribution-spec v1.1 exchanges (tags list with Link pagination, WWW-Authenticate bearer token, HEAD manifest digest, manifest by digest, referrers API with tag-schema fallback, blob). Generated from test/sources/oci-fixtures.ts and verified by contracts/sources.consumer.test.ts.",
		OCI_FIXTURES.map((item) =>
			interaction(item, describeExchange(item), (url) =>
				url.includes("/blobs/"),
			),
		),
	),
);

write(
	"sources.git.pact.json",
	pact(
		"HoboCdGitSubscriptionDriver",
		"GitSmartHttpV2",
		"Recorded from a real `git upload-pack` (protocol v2, stateless RPC) by test/sources/fixtures/generate-git.ts: capability advertisement, ls-refs with ref-prefix and peel, and shallow filtered fetches. Bodies are base64. Verified by contracts/sources.consumer.test.ts.",
		Object.entries(gitFixture.sets).flatMap(([set, items]) =>
			items.map((item, index) => {
				const exchange: MutableExchange = {
					method: item.method,
					url: item.url,
					headers:
						item.method === "POST"
							? {
									"git-protocol": "version=2",
									"content-type": "application/x-git-upload-pack-request",
								}
							: { "git-protocol": "version=2" },
					response: Buffer.from(item.response, "base64").toString("latin1"),
				};
				if ("body" in item && item.body !== undefined)
					exchange.body = item.body;
				const result = interaction(
					exchange,
					`${set}#${index} ${describeExchange(exchange)}`,
					() => true,
				);
				return {
					...result,
					providerStates: [
						{ name: `origin ${new URL(item.url).origin}` },
						{ name: `repository at ${set}` },
					],
				};
			}),
		),
	),
);

write(
	"sources.packages.pact.json",
	pact(
		"HoboCdPackageRegistryDriver",
		"PackageRegistries",
		"Hand-authored registry metadata exchanges per ecosystem (npm packument, PyPI JSON API, crates.io sparse index, RubyGems versions API, NuGet flat container, Maven maven-metadata.xml and .sha256 sidecar) plus package downloads hashed when no sha256 is published. Generated from test/sources/package-fixtures.ts and verified by contracts/sources.consumer.test.ts.",
		PACKAGE_FIXTURES.map((item) =>
			interaction(item, describeExchange(item), (url) =>
				/\.(tgz|nupkg|jar)$/.test(url),
			),
		),
	),
);
process.stdout.write("wrote sources.{oci,git,packages}.pact.json\n");
