import {
	createMockProviderFromPact,
	isRecursiveSubset,
	type PactDocument,
	type PactInteraction,
	type PactRequest,
	subsetMismatchPath,
} from "@hobo/contract-harness";
import type {
	HttpTransport,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";

// public-contract: the ways a request can fail to honour the contract it is replayed against.
export const PACT_FIDELITY_KINDS = Object.freeze([
	"unmatched-path",
	"body-mismatch",
	"header-mismatch",
] as const);

export type PactFidelityKind = (typeof PACT_FIDELITY_KINDS)[number];

export interface PactFidelityViolation {
	readonly kind: PactFidelityKind;
	readonly method: string;
	readonly path: string;
	readonly callIndex: number;
	readonly detail: string;
}

export interface PactLifecycle {
	readonly initial: string;
	readonly created: string;
	readonly creates: readonly string[];
	readonly identity?: "provider-minted" | "client-supplied";
	readonly answers: Readonly<Record<string, Readonly<Record<string, string>>>>;
	readonly transitions: Readonly<Record<string, string>>;
}

export interface PactWorld {
	readonly transport: HttpTransport;
	readonly fetchImpl: typeof fetch;
	readonly calls: readonly PactRequest[];
	state: () => string;
	countCreates: () => number;
	countUnmatched: () => number;
	fidelityViolations: () => readonly PactFidelityViolation[];
}

export class PactLifecycleError extends Error {
	readonly code = "PACT_LIFECYCLE_INVALID";
	readonly remediation: string;
	constructor(message: string, remediation: string) {
		super(message);
		this.name = "PactLifecycleError";
		this.remediation = remediation;
	}
}

function selectorOf(method: string, path: string): string {
	return `${method} ${path}`;
}

function parseSelector(selector: string): {
	method: string;
	path: string;
} {
	const space = selector.indexOf(" ");
	if (space <= 0) {
		throw new PactLifecycleError(
			`selector ${JSON.stringify(selector)} is not "METHOD /path"`,
			'write selectors as "GET /v4/zones/zone-1/dns_records?per_page=100"',
		);
	}
	return {
		method: selector.slice(0, space),
		path: selector.slice(space + 1),
	};
}

function parseBody(body: string | undefined): unknown {
	if (body === undefined || body.length === 0) return undefined;
	try {
		return JSON.parse(body) as unknown;
	} catch {
		return body;
	}
}

function lowerKeys(
	headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers ?? {})) {
		out[key.toLowerCase()] = value;
	}
	return out;
}

function assertFilterConsistency(
	selector: string,
	answering: PactInteraction,
): void {
	const { path } = parseSelector(selector);
	const queryStart = path.indexOf("?");
	if (queryStart < 0) return;
	const params = new URLSearchParams(path.slice(queryStart + 1));
	if ([...params.keys()].length === 0) return;

	for (const element of collectionElements(answering.response.body)) {
		for (const [key, expected] of params) {
			if (!(key in element)) continue;
			const actual = element[key];
			if (String(actual) !== expected) {
				throw new PactLifecycleError(
					`answering ${JSON.stringify(selector)} with interaction ${JSON.stringify(
						answering.description,
					)} would return a record whose ${key} is ${JSON.stringify(
						actual,
					)} while the query asks for ${JSON.stringify(expected)}`,
					"answer a filtered read only with an interaction whose records satisfy that filter, or record a filtered interaction for the populated state",
				);
			}
		}
	}
}

function collectionElements(
	body: unknown,
): readonly Readonly<Record<string, unknown>>[] {
	const found: Readonly<Record<string, unknown>>[] = [];
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const item of node) {
				if (typeof item === "object" && item !== null && !Array.isArray(item)) {
					found.push(item as Record<string, unknown>);
				}
			}
			return;
		}
		if (typeof node === "object" && node !== null) {
			for (const value of Object.values(node)) visit(value);
		}
	};
	visit(body);
	return found;
}

function assertLifecycle(pact: PactDocument, lifecycle: PactLifecycle): void {
	const byDescription = new Map(
		pact.interactions.map((i) => [i.description, i]),
	);
	const declared = new Set(
		pact.interactions.map((i) => selectorOf(i.request.method, i.request.path)),
	);
	const states = new Set([
		lifecycle.initial,
		...Object.keys(lifecycle.answers),
		...Object.values(lifecycle.transitions),
	]);

	if (!states.has(lifecycle.created)) {
		throw new PactLifecycleError(
			`created state ${JSON.stringify(lifecycle.created)} is not one of ${[...states].join(", ")}`,
			"name a state the world can actually reach — one that is the initial state, has answers, or is some transition's target",
		);
	}

	for (const [stateName, answers] of Object.entries(lifecycle.answers)) {
		for (const [selector, description] of Object.entries(answers)) {
			parseSelector(selector);
			if (!declared.has(selector)) {
				throw new PactLifecycleError(
					`state ${JSON.stringify(stateName)} answers ${JSON.stringify(selector)}, which no interaction declares`,
					`declared selectors: ${[...declared].sort().join(", ")}`,
				);
			}
			const answering = byDescription.get(description);
			if (!answering) {
				throw new PactLifecycleError(
					`state ${JSON.stringify(stateName)} answers with interaction ${JSON.stringify(description)}, which the pact does not contain`,
					`available descriptions: ${[...byDescription.keys()].join(", ")}`,
				);
			}
			assertFilterConsistency(selector, answering);
		}
	}

	for (const selector of lifecycle.creates) {
		parseSelector(selector);
		if (!declared.has(selector)) {
			throw new PactLifecycleError(
				`creates lists ${JSON.stringify(selector)}, which no interaction declares`,
				`declared selectors: ${[...declared].sort().join(", ")}`,
			);
		}
	}

	for (const [selector, to] of Object.entries(lifecycle.transitions)) {
		parseSelector(selector);
		if (!declared.has(selector)) {
			throw new PactLifecycleError(
				`transition on ${JSON.stringify(selector)} names a request no interaction declares`,
				`declared selectors: ${[...declared].sort().join(", ")}`,
			);
		}
		if (!states.has(to)) {
			throw new PactLifecycleError(
				`transition on ${JSON.stringify(selector)} moves to unknown state ${JSON.stringify(to)}`,
				`known states: ${[...states].join(", ")}`,
			);
		}
	}
}

export function fetchFromTransport(transport: HttpTransport): typeof fetch {
	return async (input, init) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: (input as Request).url;
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((value, key) => {
			headers[key] = value;
		});
		const response = await transport({
			method: (
				init?.method ?? "GET"
			).toUpperCase() as TransportRequest["method"],
			url,
			headers,
			timeoutMs: 5_000,
			maxResponseBytes: 256 * 1024,
			...(typeof init?.body === "string" ? { body: init.body } : {}),
		});
		return new Response(response.body, {
			status: response.status,
			headers: response.headers as HeadersInit,
		});
	};
}

export function pactBackedTransport(
	pact: PactDocument,
	options: { readonly lifecycle?: PactLifecycle } = {},
): PactWorld {
	const lifecycle = options.lifecycle;
	if (lifecycle) assertLifecycle(pact, lifecycle);

	const byDescription = new Map(
		pact.interactions.map((i) => [i.description, i]),
	);
	const calls: PactRequest[] = [];
	const violations: PactFidelityViolation[] = [];
	let state = lifecycle?.initial ?? "";
	let creates = 0;
	let unmatched = 0;

	function classify(
		request: PactRequest,
		callIndex: number,
	): PactInteraction | undefined {
		const samePath = pact.interactions.filter(
			(i) =>
				i.request.method === request.method && i.request.path === request.path,
		);
		if (samePath.length === 0) {
			unmatched += 1;
			violations.push({
				kind: "unmatched-path",
				method: request.method,
				path: request.path,
				callIndex,
				detail: "no interaction declares this method and path",
			});
			return undefined;
		}

		const actualHeaders = lowerKeys(request.headers);
		const headerOk = samePath.filter((i) =>
			Object.entries(lowerKeys(i.request.headers)).every(
				([key, value]) => actualHeaders[key] === value,
			),
		);
		if (headerOk.length === 0) {
			const missing = Object.entries(lowerKeys(samePath[0]?.request.headers))
				.filter(([key, value]) => actualHeaders[key] !== value)
				.map(
					([key, value]) =>
						`${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actualHeaders[key])}`,
				);
			violations.push({
				kind: "header-mismatch",
				method: request.method,
				path: request.path,
				callIndex,
				detail: missing.join("; "),
			});
			return samePath[0];
		}

		const withBody = headerOk.filter((i) => i.request.body !== undefined);
		if (withBody.length > 0) {
			const bodyOk = withBody.filter((i) =>
				isRecursiveSubset(i.request.body, request.body),
			);
			if (bodyOk.length === 0) {
				violations.push({
					kind: "body-mismatch",
					method: request.method,
					path: request.path,
					callIndex,
					detail: `recorded request body is not a subset of what was sent; first divergence at ${subsetMismatchPath(
						withBody[0]?.request.body,
						request.body,
					)}`,
				});
				return withBody[0];
			}
			return bodyOk[0];
		}

		return headerOk[0];
	}

	async function handle(request: PactRequest): Promise<TransportResponse> {
		const callIndex = calls.length;
		calls.push(request);

		const selector = selectorOf(request.method, request.path);
		const matched = classify(request, callIndex);

		if (lifecycle?.creates.includes(selector)) creates += 1;

		if (!matched) {
			return {
				status: 404,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ error: { code: "PACT_NO_INTERACTION" } }),
			};
		}

		const override = lifecycle?.answers[state]?.[selector];
		const serving = override
			? (byDescription.get(override) ?? matched)
			: matched;

		const next = lifecycle?.transitions[selector];
		if (next !== undefined && serving.response.status < 300) state = next;

		return {
			status: serving.response.status,
			headers: {
				"content-type": "application/json",
				...(serving.response.headers ?? {}),
			},
			body:
				serving.response.body === undefined
					? ""
					: JSON.stringify(serving.response.body),
		};
	}

	const transport: HttpTransport = async (request) => {
		const url = new URL(request.url);
		const body = parseBody(request.body);
		return handle({
			method: request.method as PactRequest["method"],
			path: `${url.pathname}${url.search}`,
			headers: request.headers,
			...(body !== undefined ? { body } : {}),
		});
	};

	return {
		transport,
		fetchImpl: fetchFromTransport(transport),
		get calls() {
			return Object.freeze([...calls]);
		},
		state: () => state,
		countCreates: () => creates,
		countUnmatched: () => unmatched,
		fidelityViolations: () => Object.freeze([...violations]),
	};
}

export async function statelessPactAnswer(
	pact: PactDocument,
	request: PactRequest,
): Promise<{ readonly status: number; readonly body: unknown }> {
	const response = await Promise.resolve(
		createMockProviderFromPact(pact).handle(request),
	);
	return { status: response.status, body: response.body };
}
