import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ReadApiClient, ReadApiError } from "../src/read-api.js";

type Interaction = Readonly<{
	description: string;
	request: Readonly<{
		method: string;
		path: string;
		query?: Readonly<{ [name: string]: readonly string[] }>;
		headers: Readonly<{ authorization: string }>;
	}>;
	response: Readonly<{
		status: number;
		headers: Readonly<{ "content-type": string }>;
		body: object;
	}>;
}>;

const pact: { interactions: readonly Interaction[] } = JSON.parse(
	readFileSync(new URL("./read-api.pact.json", import.meta.url), "utf8"),
);

function pactFetch(matched: string[]): typeof fetch {
	return async (input, init) => {
		const url = new URL(String(input));
		const query = new Map<string, string[]>();
		for (const [name, value] of url.searchParams)
			query.set(name, [...(query.get(name) ?? []), value]);
		const authorization = new Headers(init?.headers).get("authorization");
		const entry = pact.interactions.find(
			(candidate) =>
				candidate.request.method === (init?.method ?? "GET") &&
				candidate.request.path === url.pathname &&
				candidate.request.headers.authorization === authorization &&
				JSON.stringify(Object.fromEntries(query)) ===
					JSON.stringify(candidate.request.query ?? {}),
		);
		if (!entry)
			return Response.json(
				{ error: `unmatched ${url.pathname}${url.search}`, code: "not-found" },
				{ status: 500 },
			);
		matched.push(entry.description);
		return Response.json(entry.response.body, {
			status: entry.response.status,
			headers: entry.response.headers,
		});
	};
}

async function refused(read: () => Promise<object>): Promise<ReadApiError> {
	const error = await read().then(
		() => undefined,
		(caught: Error) => caught,
	);
	if (!(error instanceof ReadApiError)) throw new Error("expected a refusal");
	return error;
}

it("reads every declared read API interaction through ReadApiClient", async () => {
	const matched: string[] = [];
	const asA = new ReadApiClient(
		"https://relay.test",
		"token-a",
		pactFetch(matched),
	);

	const order = await asA.runnerOrder("octo/app");
	expect(order.order.steps.map((step) => step.key)).toEqual([
		"machine",
		"github",
	]);
	expect(order.problem).toBe("");

	const routes = await asA.routes({ repository: "octo/app", limit: 1 });
	expect(routes.rows).toHaveLength(1);
	expect(routes.rows[0]?.decision?.outcome).toBe("routed");
	expect(routes.next).toBe("1");

	const machines = await asA.machines();
	expect(machines.rows.map((machine) => machine.id)).toEqual(["m-a"]);
	expect(machines.next).toBeUndefined();

	const runs = await asA.runs({ repository: "octo/app" });
	expect(runs.rows.map((run) => run.id)).toEqual([102, 101]);

	const jobs = await asA.jobs(102, 1);
	expect(jobs.rows.map((job) => job.name)).toEqual(["test", "lint"]);
	expect(jobs.rows[0]?.steps).toHaveLength(2);

	const signals = await asA.signals({ repository: "octo/app" });
	expect(signals.signals.signals).toHaveLength(9);
	const times = await asA.jobTimes({ repository: "octo/app" });
	expect(times.workflows[0]?.workflow).toBe("CI");
	const usage = await asA.usage({ repository: "octo/app" });
	expect(usage.included?.includedMinutes).toBe(3000);

	const writer = new ReadApiClient(
		"https://relay.test",
		"token-write",
		pactFetch(matched),
	);
	expect(await refused(() => writer.machines())).toMatchObject({
		status: 403,
		code: "forbidden",
	});
	const asB = new ReadApiClient(
		"https://relay.test",
		"token-b",
		pactFetch(matched),
	);
	expect(
		await refused(() => asB.runs({ repository: "octo/app" })),
	).toMatchObject({ status: 404, code: "not-found" });
	expect(await refused(() => asA.signals())).toMatchObject({
		status: 404,
		code: "not-stored-here",
		command: "hobo ci signals",
	});

	expect(matched).toEqual(
		pact.interactions.map((interaction) => interaction.description),
	);
});
