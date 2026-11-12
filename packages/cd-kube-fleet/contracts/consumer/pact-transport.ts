// Pact-derived mock provider: replays a pact's interactions, in order, for
// the requests the consumer actually sends, and asserts each request against
// the recorded expectation (method, path, query, header subset, body subset).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpTransport, JsonObject, JsonValue, TransportRequest, TransportResponse } from "@hobo/core";
import { expect } from "vitest";

export type PactInteraction = {
	description: string;
	providerState?: string;
	request: {
		method: string;
		path: string;
		query?: string;
		headers?: Record<string, string>;
		body?: JsonObject;
	};
	response: {
		status: number;
		headers?: Record<string, string>;
		body?: JsonValue;
	};
};

export type Pact = {
	consumer: { name: string };
	provider: { name: string };
	interactions: PactInteraction[];
};

const here = dirname(fileURLToPath(import.meta.url));

export function loadPact(name: string): Pact {
	// SAFETY: pact files are JSON documents of this shape.
	return JSON.parse(readFileSync(join(here, "../pacts", `${name}.pact.json`), "utf8")) as Pact;
}

/** The interactions recorded for one provider state, in order. */
export function state(pact: Pact, providerState: string): PactInteraction[] {
	return pact.interactions.filter((i) => i.providerState === providerState);
}

/** Transport that serves `interactions` strictly in order. */
export function pactTransport(interactions: readonly PactInteraction[]): HttpTransport & { readonly served: () => number } {
	let next = 0;
	const transport = async (request: TransportRequest): Promise<TransportResponse> => {
		const interaction = interactions[next];
		if (interaction === undefined) throw new Error(`no pact interaction left for ${request.method} ${request.url}`);
		next += 1;
		const url = new URL(request.url);
		expect(`${request.method} ${url.pathname}`, interaction.description).toBe(`${interaction.request.method} ${interaction.request.path}`);
		expect(url.search.replace(/^\?/u, ""), interaction.description).toBe(interaction.request.query ?? "");
		expect(request.headers, interaction.description).toMatchObject(interaction.request.headers ?? {});
		if (interaction.request.body !== undefined) {
			// SAFETY: request bodies this consumer sends are JSON.
			expect(JSON.parse(request.body ?? "null") as JsonValue, interaction.description).toMatchObject(interaction.request.body);
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
