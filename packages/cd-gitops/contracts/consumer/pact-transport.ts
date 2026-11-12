// Pact-derived mock provider: replays a pact's interactions, in order, for
// the requests the consumer actually sends, and asserts each request against
// the recorded expectation (method, path, query, header subset, body subset).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	HttpTransport,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import { expect } from "vitest";

export type PactInteraction = {
	description: string;
	providerState?: string;
	request: {
		method: string;
		path: string;
		query?: string;
		headers?: Record<string, string>;
		body?: unknown;
	};
	response: {
		status: number;
		headers?: Record<string, string>;
		body?: unknown;
	};
};

export type Pact = {
	consumer: { name: string };
	provider: { name: string };
	interactions: PactInteraction[];
};

const here = dirname(fileURLToPath(import.meta.url));

export function loadPact(name: string): Pact {
	return JSON.parse(
		readFileSync(join(here, "../pacts", `${name}.pact.json`), "utf8"),
	);
}

function bodyOf(request: TransportRequest): unknown {
	const type = request.headers["content-type"] ?? "";
	if (type.startsWith("application/x-www-form-urlencoded")) {
		return {
			form: Object.fromEntries(new URLSearchParams(request.body ?? "")),
		};
	}
	return request.body === undefined ? undefined : JSON.parse(request.body);
}

/** Transport that serves `interactions` strictly in order. */
export function pactTransport(
	interactions: readonly PactInteraction[],
): HttpTransport & {
	readonly served: () => number;
} {
	let next = 0;
	const transport = async (
		request: TransportRequest,
	): Promise<TransportResponse> => {
		const interaction = interactions[next];
		if (interaction === undefined)
			throw new Error(
				`no pact interaction left for ${request.method} ${request.url}`,
			);
		next += 1;
		const url = new URL(request.url);
		expect(`${request.method} ${url.pathname}`, interaction.description).toBe(
			`${interaction.request.method} ${interaction.request.path}`,
		);
		expect(url.search.replace(/^\?/u, ""), interaction.description).toBe(
			interaction.request.query ?? "",
		);
		expect(request.headers, interaction.description).toMatchObject(
			interaction.request.headers ?? {},
		);
		if (interaction.request.body !== undefined) {
			expect(bodyOf(request), interaction.description).toMatchObject(
				interaction.request.body as object,
			);
		}
		const body = interaction.response.body;
		return {
			status: interaction.response.status,
			headers: interaction.response.headers ?? {},
			body: body === undefined ? "" : JSON.stringify(body),
		};
	};
	return Object.assign(transport, { served: () => next });
}
