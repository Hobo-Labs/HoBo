import { describe, expect, it } from "vitest";
import {
	retireRepositoryVariables,
	type VariableRetireLog,
} from "../src/fleet-routes.js";
import type { GithubTransport } from "../src/github.js";

const REPOSITORY = "Hobo-Labs/HoBo";
const NAMES = [
	"HOBO_CI_FLEET_ROUTES",
	"HOBO_CI_FLEET_STATE",
	"HOBO_CI_FLEET_CAPACITY",
	"HOBO_CI_ROUTE",
];

function github(statusFor: (name: string) => number | Error) {
	const calls: { path: string; method: string }[] = [];
	const transport: GithubTransport = {
		async request(_installationId, path, method = "GET") {
			calls.push({ path, method });
			const name = path.split("/").at(-1) ?? "";
			const status = statusFor(name);
			if (status instanceof Error) throw status;
			return new Response(null, { status });
		},
	};
	return { transport, calls };
}

function recorder() {
	const events: {
		event: string;
		fields: Readonly<Record<string, string | number | boolean>>;
	}[] = [];
	const log: VariableRetireLog = (event, fields) =>
		events.push({ event, fields: { ...fields } });
	return { events, log };
}

// Plan 0026, M9: 204/404 are success, 403 is logged once, nothing throws.
describe("retireRepositoryVariables", () => {
	it("sends one DELETE per name and counts 204 and 404 as retired", async () => {
		const api = github((name) => (name === "HOBO_CI_FLEET_STATE" ? 404 : 204));
		const { events, log } = recorder();
		const outcome = await retireRepositoryVariables(api.transport, {
			installationId: 7,
			repository: REPOSITORY,
			names: NAMES,
			log,
		});
		expect(api.calls).toEqual(
			NAMES.map((name) => ({
				path: `/repos/${REPOSITORY}/actions/variables/${name}`,
				method: "DELETE",
			})),
		);
		expect(outcome).toEqual({ retired: NAMES, refused: [], failed: [] });
		expect(events.map((entry) => entry.event)).toEqual(
			NAMES.map(() => "hobo_ci_variable_retired"),
		);
	});

	it("logs a 403 once, naming every variable it leaves, and stops", async () => {
		const api = github(() => 403);
		const { events, log } = recorder();
		const outcome = await retireRepositoryVariables(api.transport, {
			installationId: 7,
			repository: REPOSITORY,
			names: NAMES,
			log,
		});
		expect(api.calls).toHaveLength(1);
		expect(outcome).toEqual({ retired: [], refused: NAMES, failed: [] });
		expect(events).toEqual([
			{
				event: "hobo_ci_variable_retire_refused",
				fields: {
					repository: REPOSITORY,
					variables: NAMES.join(","),
					status: 403,
				},
			},
		]);
	});

	it("never throws: a failure or a thrown transport is logged and the rest still go", async () => {
		const api = github((name) =>
			name === "HOBO_CI_FLEET_ROUTES"
				? new Error("socket hang up")
				: name === "HOBO_CI_FLEET_STATE"
					? 502
					: 204,
		);
		const { events, log } = recorder();
		const outcome = await retireRepositoryVariables(api.transport, {
			installationId: 7,
			repository: REPOSITORY,
			names: NAMES,
			log,
		});
		expect(outcome).toEqual({
			retired: ["HOBO_CI_FLEET_CAPACITY", "HOBO_CI_ROUTE"],
			refused: [],
			failed: ["HOBO_CI_FLEET_ROUTES", "HOBO_CI_FLEET_STATE"],
		});
		expect(events.slice(0, 2)).toEqual([
			{
				event: "hobo_ci_variable_retire_failed",
				fields: {
					repository: REPOSITORY,
					variable: "HOBO_CI_FLEET_ROUTES",
					message: "socket hang up",
				},
			},
			{
				event: "hobo_ci_variable_retire_failed",
				fields: {
					repository: REPOSITORY,
					variable: "HOBO_CI_FLEET_STATE",
					status: 502,
				},
			},
		]);
	});

	it("skips a name that is not a variable name and a duplicate", async () => {
		const api = github(() => 204);
		await retireRepositoryVariables(api.transport, {
			installationId: 7,
			repository: REPOSITORY,
			names: ["HOBO_CI_ROUTE", "HOBO_CI_ROUTE", "../secrets"],
		});
		expect(api.calls).toHaveLength(1);
	});
});
