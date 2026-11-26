import {
	createMockProviderFromPact,
	isRecursiveSubset,
	type PactRequest,
	parsePactDocument,
} from "@hobo/contract-harness";
import document from "../live.pact.json" with { type: "json" };
import edgeDocument from "../live-edge.pact.json" with { type: "json" };

export const adoPact = parsePactDocument(document);
export const adoEdgePact = parsePactDocument(edgeDocument);
const allInteractions = [...adoPact.interactions, ...adoEdgePact.interactions];
export const adoTarget = document.metadata.consumerFixtures.target;
export const adoExpectedPlan = document.metadata.consumerFixtures.planDigest;

/** Local scenario ordering over recorded interactions; never invents response payloads. */
export function createAdoPactBroker(sequence: readonly string[]) {
	const interactions = sequence.map((description) => {
		const interaction = allInteractions.find(
			(row) => row.description === description,
		);
		if (!interaction)
			throw new Error(`Pact interaction missing: ${description}`);
		return interaction;
	});
	const calls: PactRequest[] = [];
	const served: string[] = [];
	const failures: string[] = [];
	let cursor = 0;
	const fetchImpl: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const text = await request.text();
		// Reuse the shared parser's derived HTTP request type, including method constraints.
		const actual = parsePactDocument({
			...adoPact,
			interactions: [
				{
					description: "observed Azure request",
					request: {
						method: request.method,
						path: `${url.pathname}${url.search}`,
						headers: Object.fromEntries(request.headers),
						body: text ? JSON.parse(text) : undefined,
					},
					response: { status: 200 },
				},
			],
		}).interactions[0]?.request;
		if (!actual) throw new Error("missing observed request");
		calls.push(actual);
		const expected = interactions[cursor];
		if (
			url.origin !== "https://dev.azure.com" ||
			request.redirect !== "error" ||
			!init?.signal ||
			!expected ||
			actual.method !== expected.request.method ||
			actual.path !== expected.request.path ||
			!isRecursiveSubset(expected.request.headers, actual.headers) ||
			!isRecursiveSubset(expected.request.body, actual.body) ||
			!isRecursiveSubset(actual.body, expected.request.body)
		) {
			const failure = `Pact request mismatch at ${cursor}: ${actual.method} ${actual.path}`;
			failures.push(failure);
			throw new Error(failure);
		}
		cursor += 1;
		served.push(expected.description);
		const provider = createMockProviderFromPact({
			...adoPact,
			interactions: [expected],
		});
		const result = await provider.handle(actual);
		const responseInit: ResponseInit = { status: result.status };
		if (result.headers) responseInit.headers = result.headers;
		return new Response(
			result.body === undefined ? null : JSON.stringify(result.body),
			responseInit,
		);
	};
	return {
		fetch: fetchImpl,
		calls,
		served,
		failures,
		assertComplete() {
			if (failures.length || cursor !== interactions.length)
				throw new Error(
					`Pact fidelity failed: ${failures.length} mismatches; ${interactions.length - cursor} unconsumed interactions`,
				);
		},
	};
}

export const adoPrelude = [
	"confirm self-hosted pool",
	"pin pipeline revision",
	"preview pinned compiled pipeline",
	"queue pinned pipeline once",
] as const;
export const adoSuccess = [
	...adoPrelude,
	"observe running pipeline",
	"observe successful pipeline",
	"inspect native pipeline timeline",
	"inspect retained pipeline artifact",
] as const;
