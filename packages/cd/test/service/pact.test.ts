/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-runtime-typeof -- SAFETY: the PACT and OpenAPI documents are controlled JSON read at the test boundary. */
// WP12 Accept: "The APIs match OpenAPI (PACT)". The provider is the real
// `createCdControlApi` over the test world. Each PACT interaction runs its
// provider state, replays the request, and verifies status, headers and a
// subset match of the body (or the SSE frames). Every JSON response is then
// validated against the schema `GET /v1/cd/openapi.json` declares for that
// path and status, so the PACT, the OpenAPI document and the handler cannot
// drift apart.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FeedRequest } from "../../src/ports.js";
import { cdOpenApi } from "../../src/service/index.js";
import { setupApi, text } from "./harness.js";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Interaction = {
	description: string;
	providerState: string;
	request: {
		method: string;
		path: string;
		query?: Record<string, string>;
		headers?: Record<string, string>;
	};
	response: {
		status: number;
		headers: Record<string, string>;
		body?: Json;
		sse?: { id?: string; event: string; data?: Json }[];
	};
};

const PACT_URL = new URL(
	"../../../control-api/contracts/pacts/control-api-cd.pact.json",
	import.meta.url,
);
const pact: {
	consumer: { name: string };
	provider: { name: string };
	interactions: Interaction[];
} = JSON.parse(readFileSync(PACT_URL, "utf8"));
const openapi = cdOpenApi() as {
	paths: Record<
		string,
		Record<
			string,
			{
				parameters?: { name: string; in: string }[];
				responses: Record<
					string,
					{ content?: Record<string, { schema: Json }> }
				>;
			}
		>
	>;
	components: { schemas: Record<string, Json> };
};

/** Recursive subset match: every expected key/element is present and equal. */
function subset(
	actual: Json | undefined,
	expected: Json,
	path = "$",
): string[] {
	if (expected === null || typeof expected !== "object") {
		return actual === expected
			? []
			: [
					`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
				];
	}
	if (Array.isArray(expected)) {
		if (!Array.isArray(actual)) return [`${path}: expected array`];
		if (actual.length < expected.length)
			return [
				`${path}: expected ≥ ${expected.length} items, got ${actual.length}`,
			];
		return expected.flatMap((e, i) => subset(actual[i], e, `${path}[${i}]`));
	}
	if (actual === null || typeof actual !== "object" || Array.isArray(actual))
		return [`${path}: expected object`];
	return Object.entries(expected).flatMap(([k, v]) =>
		subset(actual[k], v, `${path}.${k}`),
	);
}

/** The JSON-Schema subset the OpenAPI document uses: $ref, type, required, properties, items, const, enum. */
function validate(value: Json | undefined, schema: Json, path = "$"): string[] {
	if (schema === null || typeof schema !== "object" || Array.isArray(schema))
		return [];
	if (typeof schema.$ref === "string") {
		const name = schema.$ref.replace("#/components/schemas/", "");
		const target = openapi.components.schemas[name];
		if (target === undefined) return [`${path}: dangling $ref ${schema.$ref}`];
		return validate(value, target, path);
	}
	const errors: string[] = [];
	if ("const" in schema && value !== schema.const)
		errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
	if (Array.isArray(schema.enum) && !schema.enum.includes(value as Json))
		errors.push(`${path}: not in enum`);
	switch (schema.type) {
		case "object": {
			if (value === null || typeof value !== "object" || Array.isArray(value))
				return [`${path}: expected object`];
			for (const key of (schema.required as string[] | undefined) ?? [])
				if (!(key in value)) errors.push(`${path}: missing ${key}`);
			const props = (schema.properties ?? {}) as Record<string, Json>;
			for (const [k, s] of Object.entries(props))
				if (k in value) errors.push(...validate(value[k], s, `${path}.${k}`));
			break;
		}
		case "array":
			if (!Array.isArray(value)) return [`${path}: expected array`];
			value.forEach((v, i) => {
				errors.push(...validate(v, schema.items as Json, `${path}[${i}]`));
			});
			break;
		case "string":
			if (typeof value !== "string") errors.push(`${path}: expected string`);
			break;
		case "boolean":
			if (typeof value !== "boolean") errors.push(`${path}: expected boolean`);
			break;
		case "integer":
			if (!Number.isInteger(value)) errors.push(`${path}: expected integer`);
			break;
	}
	return errors;
}

function templateFor(path: string): string | undefined {
	return Object.keys(openapi.paths).find((t) =>
		new RegExp(
			`^${t.replace(/\{[^}]+\}/g, "[^/]+").replace(/\./g, "\\.")}$`,
		).test(path),
	);
}

function sseFrames(raw: string) {
	return raw
		.split("\n\n")
		.filter((b) => /^event: /m.test(b))
		.map((b) => ({
			id: /^id: (.*)$/m.exec(b)?.[1],
			event: /^event: (.*)$/m.exec(b)?.[1] ?? "",
			data: JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? "null") as Json,
		}));
}

async function providerFor(state: string) {
	const env = setupApi({ streamMaxMs: 30 });
	if (state === "the CD service is started") await env.service.start();
	return env;
}

describe("PACT @hobo/hobo → @hobo/control-api (/v1/cd read API)", () => {
	it("names its parties and covers every OpenAPI read route", () => {
		expect(pact.provider.name).toBe("@hobo/control-api");
		expect(pact.consumer.name).toBe("@hobo/hobo");
		const covered = new Set(
			pact.interactions.map((i) => templateFor(i.request.path)),
		);
		const routes = Object.keys(openapi.paths).filter(
			(p) => p !== "/v1/cd/openapi.json",
		);
		expect(routes.filter((r) => !covered.has(r))).toEqual([]);
	});

	for (const interaction of pact.interactions) {
		it(interaction.description, async () => {
			const env = await providerFor(interaction.providerState);
			const { path, query, method, headers } = interaction.request;
			const search = query ? `?${new URLSearchParams(query).toString()}` : "";
			const request: FeedRequest = {
				method,
				path: `${path}${search}`,
				headers: headers ?? {},
				body: new Uint8Array(),
			};
			const res = await env.api.handle(request, new AbortController().signal);
			expect(res.status).toBe(interaction.response.status);
			for (const [k, v] of Object.entries(interaction.response.headers))
				expect(res.headers[k]).toBe(v);

			// The path must be an OpenAPI route and every query/header parameter declared.
			const template = templateFor(path);
			expect(template, `${path} is not in the OpenAPI document`).toBeDefined();
			const operation = openapi.paths[template ?? ""]?.get;
			if (method === "GET") {
				expect(operation).toBeDefined();
				const declared = new Set(
					(operation?.parameters ?? []).map((p) => p.name.toLowerCase()),
				);
				for (const key of Object.keys(query ?? {}))
					expect(declared.has(key.toLowerCase()), `query ${key}`).toBe(true);
				for (const key of Object.keys(headers ?? {}))
					expect(declared.has(key.toLowerCase()), `header ${key}`).toBe(true);
				expect(Object.keys(operation?.responses ?? {})).toContain(
					String(res.status),
				);
			}

			if (interaction.response.sse) {
				const frames = sseFrames(await text(res));
				expect(frames).toHaveLength(interaction.response.sse.length);
				interaction.response.sse.forEach((want, i) => {
					const got = frames[i];
					expect(got?.event).toBe(want.event);
					if (want.id) expect(got?.id).toBe(want.id);
					if (want.data) expect(subset(got?.data, want.data)).toEqual([]);
					if (want.event !== "end") {
						expect(
							validate(got?.data, { $ref: "#/components/schemas/StreamFrame" }),
						).toEqual([]);
					}
				});
				await env.service.drain(AbortSignal.timeout(500));
				return;
			}

			const body = JSON.parse(await text(res)) as Json;
			expect(subset(body, interaction.response.body ?? {})).toEqual([]);
			if (method === "GET") {
				const schema =
					operation?.responses[String(res.status)]?.content?.[
						"application/json"
					]?.schema;
				expect(schema, `no schema for ${res.status}`).toBeDefined();
				expect(validate(body, schema ?? null)).toEqual([]);
			} else {
				expect(
					validate(body, { $ref: "#/components/schemas/Refusal" }),
				).toEqual([]);
			}
			await env.service.drain(AbortSignal.timeout(500));
		});
	}
});
