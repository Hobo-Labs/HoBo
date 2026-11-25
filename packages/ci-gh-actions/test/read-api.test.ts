import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	READ_API_ROUTES,
	ReadApiClient,
	ReadApiError,
	readApiOpenApi,
} from "../src/read-api.js";
import {
	decided,
	NOW,
	type ReadApiFixture,
	readApiFixture,
	readPath,
} from "./support/read-api-fixture.js";

type Json =
	| string
	| number
	| boolean
	| null
	| readonly Json[]
	| { readonly [key: string]: Json };

const OPENAPI: { readonly [key: string]: Json } = JSON.parse(
	readFileSync(
		new URL("../schema/read-api.openapi.json", import.meta.url),
		"utf8",
	),
);

function isRecord(
	value: Json | undefined,
): value is { readonly [key: string]: Json } {
	return value instanceof Object && !Array.isArray(value);
}

function field(value: Json | undefined, name: string): Json | undefined {
	return isRecord(value) ? value[name] : undefined;
}

function resolve(schema: Json | undefined): Json | undefined {
	const ref = field(schema, "$ref");
	if (!(ref instanceof Object) && String(ref ?? "").startsWith("#/")) {
		let target: Json | undefined = OPENAPI;
		for (const part of String(ref).slice(2).split("/"))
			target = field(target, part);
		return target;
	}
	return schema;
}

function kind(value: Json): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (value instanceof Object) return "object";
	if (Number.isInteger(value)) return "integer";
	return String(value) === value
		? "string"
		: value === true || value === false
			? "boolean"
			: "number";
}

function violations(value: Json, raw: Json | undefined, at = "$"): string[] {
	const schema = resolve(raw);
	if (schema === undefined) return [`${at}: no schema`];
	const found: string[] = [];
	const type = field(schema, "type");
	const actual = kind(value);
	if (
		type !== undefined &&
		type !== actual &&
		!(type === "number" && actual === "integer")
	)
		return [`${at}: ${actual} is not ${String(type)}`];
	const choices = field(schema, "enum");
	if (Array.isArray(choices) && !choices.includes(value))
		found.push(`${at}: ${String(value)} is not one of ${choices.join(", ")}`);
	const minimum = field(schema, "minimum");
	if (minimum !== undefined && Number(value) < Number(minimum))
		found.push(`${at}: below ${String(minimum)}`);
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			found.push(
				...violations(item, field(schema, "items"), `${at}[${index}]`),
			);
		});
	} else if (actual === "object") {
		const properties = field(schema, "properties");
		const extra = field(schema, "additionalProperties");
		const required = field(schema, "required");
		for (const name of Array.isArray(required) ? required : [])
			if (field(value, String(name)) === undefined)
				found.push(`${at}.${String(name)}: required`);
		for (const [name, item] of Object.entries(isRecord(value) ? value : {})) {
			const property = field(properties, name);
			if (property !== undefined)
				found.push(...violations(item, property, `${at}.${name}`));
			else if (extra === false) found.push(`${at}.${name}: not allowed`);
			else if (extra instanceof Object)
				found.push(...violations(item, extra, `${at}.${name}`));
		}
	}
	return found;
}

function responseSchema(path: string, status: number): Json | undefined {
	let schema: Json | undefined = field(OPENAPI, "paths");
	for (const part of [
		path,
		"get",
		"responses",
		String(status),
		"content",
		"application/json",
		"schema",
	])
		schema = field(schema, part);
	return schema;
}

async function body(response: Response): Promise<Json> {
	const parsed: Json = await response.json();
	return parsed;
}

const PATHS = new Map([
	["/runner-order", "?repository=octo/app"],
	["/routes", ""],
	["/machines", ""],
	["/runs", ""],
	["/runs/{id}/{attempt}/jobs", ""],
	["/signals", ""],
	["/job-times", ""],
	["/usage", ""],
]);

function concrete(path: string): string {
	return `/v1/accounts/self${path.replace("{id}", "102").replace("{attempt}", "1")}${PATHS.get(path) ?? ""}`;
}

describe("read API (S06)", () => {
	it("S06: each read API path, called with a read token, answers what the OpenAPI description says", async () => {
		const fixture = await readApiFixture();
		expect(READ_API_ROUTES.map((route) => route.path).sort()).toEqual(
			[...PATHS.keys()].sort(),
		);
		for (const route of READ_API_ROUTES) {
			const path = concrete(route.path);
			const response = await readPath(fixture, path);
			expect(response.status, path).toBe(200);
			expect(response.headers.get("content-type")).toBe("application/json");
			const template = `/v1/accounts/self${route.path}`;
			expect(
				violations(await body(response), responseSchema(template, 200)),
				path,
			).toEqual([]);
		}
		for (const [path, token, status] of [
			["/v1/accounts/self/routes", "", 401],
			["/v1/accounts/self/routes", "token-write", 403],
			["/v1/accounts/self/routes?limit=0", "token-a", 400],
			["/v1/accounts/self/runner-order?repository=other/svc", "token-a", 404],
		] as const) {
			const response = await readPath(fixture, path, token);
			expect(response.status, path).toBe(status);
			const template = path.split("?")[0] ?? "";
			expect(
				violations(await body(response), responseSchema(template, status)),
			).toEqual([]);
		}
	});

	it("checks answers against the description strictly enough to catch a wrong one", () => {
		const routes = responseSchema("/v1/accounts/self/routes", 200);
		expect(violations({ routes: [] }, routes)).toEqual([]);
		expect(
			violations({ routes: [{ atMs: "soon", colour: 1 }] }, routes),
		).toEqual([
			"$.routes[0].atMs: string is not number",
			"$.routes[0].colour: not allowed",
		]);
		expect(violations({}, routes)).toEqual(["$.routes: required"]);
	});

	it("keeps the committed OpenAPI description equal to the route table's", () => {
		expect(
			readFileSync(
				new URL("../schema/read-api.openapi.json", import.meta.url),
				"utf8",
			),
		).toBe(readApiOpenApi());
	});

	it("describes every frozen path, its parameters and the read scope", () => {
		const paths = field(OPENAPI, "paths");
		for (const route of READ_API_ROUTES) {
			const get = field(field(paths, `/v1/accounts/self${route.path}`), "get");
			expect(field(get, "operationId")).toBe(route.operationId);
			expect(String(field(get, "description"))).toContain("policy:read");
		}
		expect(field(OPENAPI, "openapi")).toBe("3.1.0");
	});
});

describe("read API access", () => {
	it("answers only GET read API paths and leaves every other path to the caller", async () => {
		const fixture = await readApiFixture();
		expect(
			await fixture.handle(
				new Request("https://relay.test/v1/accounts/self/leases"),
			),
		).toBeUndefined();
		expect(
			await fixture.handle(
				new Request("https://relay.test/v2/accounts/self/signals"),
			),
		).toBeUndefined();
		const post = await fixture.handle(
			new Request("https://relay.test/v1/accounts/self/routes", {
				method: "POST",
				headers: { authorization: "Bearer token-a" },
			}),
		);
		expect(post?.status).toBe(405);
	});

	it("needs an account token holding the read scope", async () => {
		const fixture = await readApiFixture();
		const anonymous = await readPath(fixture, "/v1/accounts/self/machines", "");
		expect(anonymous.status).toBe(401);
		expect(await body(anonymous)).toMatchObject({ code: "unauthenticated" });
		const unknown = await readPath(
			fixture,
			"/v1/accounts/self/machines",
			"nobody",
		);
		expect(unknown.status).toBe(401);
		const writer = await readPath(
			fixture,
			"/v1/accounts/self/machines",
			"token-write",
		);
		expect(writer.status).toBe(403);
		expect(await body(writer)).toMatchObject({
			code: "forbidden",
			error: "account scope required: policy:read",
		});
	});

	it("never answers one account another account's rows", async () => {
		const fixture = await readApiFixture();
		const asA = new ReadApiClient(
			"https://relay.test",
			"token-a",
			clientFetch(fixture),
		);
		const asB = new ReadApiClient(
			"https://relay.test",
			"token-b",
			clientFetch(fixture),
		);

		expect((await asA.routes()).rows.map((row) => row.jobId)).toEqual([
			"job-a3",
			"job-a2",
			"job-a1",
		]);
		expect((await asB.routes()).rows.map((row) => row.jobId)).toEqual([
			"job-b1",
		]);
		expect((await asA.machines()).rows.map((row) => row.id)).toEqual(["m-a"]);
		expect((await asB.machines()).rows.map((row) => row.id)).toEqual(["m-b"]);
		expect((await asA.runs()).rows.map((row) => row.id)).toEqual([
			103, 102, 101,
		]);
		expect((await asB.runs()).rows.map((row) => row.id)).toEqual([201]);
		expect((await asB.signals()).runs).toBe(1);
		expect((await asB.usage()).runs).toBe(1);
		expect((await asB.jobTimes()).runs).toBe(1);

		for (const read of [
			() => asB.routes({ repository: "octo/app" }),
			() => asB.runs({ repository: "octo/app" }),
			() => asB.jobs(102, 1),
			() => asB.jobs(102, 1, { repository: "octo/app" }),
			() => asB.runnerOrder("octo/app"),
			() => asB.signals({ repository: "octo/app" }),
			() => asB.usage({ repository: "octo/app" }),
			() => asB.jobTimes({ repository: "octo/app" }),
		]) {
			const error = await read().then(
				() => undefined,
				(caught: Error) => caught,
			);
			expect(error).toBeInstanceOf(ReadApiError);
			expect(error).toMatchObject({ status: 404, code: "not-found" });
		}
	});

	it("drops a row a store hands back for another account", async () => {
		const fixture = await readApiFixture();
		const leaky: ReadApiFixture = {
			...fixture,
			handle: async (request) => {
				const original = fixture.journal.decisions.bind(fixture.journal);
				fixture.journal.decisions = async (query) =>
					original({ ...query, accountId: "acct-b" }).then(async (rows) => [
						...rows,
						...(await original(query)),
					]);
				try {
					return await fixture.handle(request);
				} finally {
					fixture.journal.decisions = original;
				}
			},
		};
		const response = await readPath(leaky, "/v1/accounts/self/routes");
		expect(JSON.stringify(await body(response))).not.toContain("acct-b");
	});
});

function clientFetch(fixture: ReadApiFixture): typeof fetch {
	return async (input, init) => {
		const response = await fixture.handle(new Request(input, init));
		return response ?? new Response("{}", { status: 404 });
	};
}

describe("read API answers", () => {
	it("answers stored records as protobuf JSON the client reads back", async () => {
		const fixture = await readApiFixture();
		const client = new ReadApiClient(
			"https://relay.test",
			"token-a",
			clientFetch(fixture),
		);
		const order = await client.runnerOrder("OCTO/app", "main");
		expect(order.repository).toBe("octo/app");
		expect(order.ref).toBe("main");
		expect(order.problem).toBe("");
		expect(order.order.steps.map((step) => step.key)).toEqual([
			"machine",
			"github",
		]);
		const broken = await client.runnerOrder("octo/site");
		expect(broken.problem).not.toBe("");

		const [route] = (await client.routes({ repository: "octo/site" })).rows;
		expect(route?.decision?.runner).toBe("ubuntu-24.04");
		expect(route?.request?.repository).toBe("octo/site");

		const runs = await client.runs({ repository: "octo/app" });
		expect(runs.rows.map((run) => [run.id, run.jobs.length])).toEqual([
			[102, 0],
			[101, 0],
		]);
		const jobs = await client.jobs(102, 1);
		expect(jobs.rows.map((job) => job.name)).toEqual(["test", "lint"]);
		expect(jobs.rows[0]?.steps.map((step) => step.name)).toEqual([
			"Set up job",
			"Test",
		]);
		expect(jobs.rows[0]?.steps[1]?.completedAtMs).toBe(
			NOW - 24 * 3_600_000 + 185_000,
		);
	});

	it("answers the signal, job-time and usage reports over stored runs", async () => {
		const fixture = await readApiFixture();
		const client = new ReadApiClient(
			"https://relay.test",
			"token-a",
			clientFetch(fixture),
		);
		const signals = await client.signals();
		expect(signals.runs).toBe(3);
		expect(signals.signals.signals).toHaveLength(9);
		expect(signals.by.repository?.map((slice) => slice.key).sort()).toEqual([
			"octo/app",
			"octo/site",
		]);
		expect(signals.trend.length).toBeGreaterThan(0);

		const times = await client.jobTimes({ repository: "octo/app" });
		expect(times.runs).toBe(2);
		expect(times.workflows.map((workflow) => workflow.workflow)).toEqual([
			"CI",
		]);
		expect(times.jobs.map((job) => job.job).sort()).toEqual(["lint", "test"]);
		expect(times.runners.map((runner) => runner.key).sort()).toEqual([
			"hobo-machine-m-a",
			"ubuntu-24.04",
		]);

		const usage = await client.usage();
		expect(usage.runs).toBe(3);
		expect(usage.rate.source).toContain("docs.github.com");
		expect(usage.billedMinutes).toBe(9);
		expect(usage.keptMinutes).toBe(3);
		expect(usage.keptUsd).toBeCloseTo(2 * 0.006);
		expect(usage.included).toMatchObject({
			usedMinutes: 1200,
			includedMinutes: 3000,
		});
		const since = await client.usage({ since: NOW - 30 * 3_600_000 });
		expect(since.runs).toBe(2);
	});

	it("pages a list newest first with an opaque cursor, each row once", async () => {
		const fixture = await readApiFixture();
		for (let index = 0; index < 7; index += 1)
			await fixture.journal.record(
				decided(
					"acct-a",
					"octo/app",
					`job-p${index}`,
					NOW - 10 * 3_600_000 - index,
				),
			);
		const client = new ReadApiClient(
			"https://relay.test",
			"token-a",
			clientFetch(fixture),
		);
		const seen: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const page = await client.routes(
				cursor === undefined ? { limit: 4 } : { limit: 4, cursor },
			);
			seen.push(...page.rows.map((row) => row.jobId));
			cursor = page.next;
			pages += 1;
		} while (cursor !== undefined);
		expect(pages).toBe(3);
		expect(seen).toEqual([
			"job-a3",
			"job-a2",
			"job-a1",
			"job-p0",
			"job-p1",
			"job-p2",
			"job-p3",
			"job-p4",
			"job-p5",
			"job-p6",
		]);
		const recent = await client.routes({ since: NOW - 2 * 3_600_000 });
		expect(recent.rows.map((row) => row.jobId)).toEqual(["job-a3", "job-a2"]);
	});

	it("refuses a malformed or unknown parameter", async () => {
		const fixture = await readApiFixture();
		for (const query of [
			"/routes?limit=201",
			"/routes?limit=abc",
			"/routes?cursor=990&limit=50",
			"/routes?repository=not-a-repository",
			"/machines?repository=octo/app",
			"/routes?colour=red",
			"/runner-order",
		]) {
			const response = await readPath(fixture, `/v1/accounts/self${query}`);
			expect(response.status, query).toBe(400);
			expect(await body(response)).toMatchObject({ code: "bad-request" });
		}
		const missing = await readPath(
			fixture,
			"/v1/accounts/self/runs/999/1/jobs",
		);
		expect(missing.status).toBe(404);
	});

	it("on a host that keeps no journal, machines or runs, names the command that reads GitHub", async () => {
		const fixture = await readApiFixture(true);
		const expected = new Map([
			["/routes", "hobo ci route"],
			["/machines", "hobo ci runners list"],
			["/runs", "gh run list"],
			["/runs/{id}/{attempt}/jobs", "gh run view <id> --attempt <attempt>"],
			["/signals", "hobo ci signals"],
			["/job-times", "hobo ci performance --source github"],
			["/usage", "hobo ci usage --source github"],
		]);
		for (const [path, command] of expected) {
			const response = await readPath(fixture, concrete(path));
			expect(response.status, path).toBe(404);
			const answer = await body(response);
			expect(answer).toMatchObject({ code: "not-stored-here", command });
			expect(String(field(answer, "error"))).toContain("not stored here");
		}
		const order = await readPath(fixture, concrete("/runner-order"));
		expect(order.status).toBe(200);
		const client = new ReadApiClient(
			"https://relay.test",
			"token-a",
			clientFetch(fixture),
		);
		await expect(client.signals()).rejects.toMatchObject({
			code: "not-stored-here",
			command: "hobo ci signals",
		});
	});
});
