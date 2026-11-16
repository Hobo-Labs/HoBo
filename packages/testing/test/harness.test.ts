import { describe, expect, it } from "vitest";
import {
	createTestHarness,
	DEFAULT_LANE,
	DEFAULT_STAGE,
	type ReadinessProbe,
	TestHarnessError,
} from "../src/index.js";
import { fakeBindle } from "./fixtures.js";

describe("createTestHarness options", () => {
	it("defaults to the in-process lane and the test stage", async () => {
		expect(DEFAULT_LANE).toBe("in-process");
		expect(DEFAULT_STAGE).toBe("test");
		const harness = createTestHarness();
		const bindle = fakeBindle();
		const graph = await harness.deploy(bindle)();
		try {
			expect(graph.lane).toBe("in-process");
			expect(graph.stage).toBe("test");
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it.each([
		["camp", "an unknown lane"],
		["", "an empty lane"],
	])("refuses lane %o (%s)", (lane) => {
		try {
			createTestHarness({ lane: lane as never });
			expect.unreachable("expected a refusal");
		} catch (error) {
			expect((error as TestHarnessError).code).toBe("HARNESS_LANE_INVALID");
		}
	});

	it.each([
		["Production", "an uppercase stage"],
		["pr 42", "a stage with a space"],
		["", "an empty stage"],
	])("refuses stage %o (%s)", (stage) => {
		try {
			createTestHarness({ stage });
			expect.unreachable("expected a refusal");
		} catch (error) {
			expect((error as TestHarnessError).code).toBe("HARNESS_STAGE_INVALID");
		}
	});

	it("accepts a per-PR stage slug", async () => {
		const harness = createTestHarness({ stage: "pr-42" });
		const bindle = fakeBindle();
		const graph = await harness.deploy(bindle)();
		try {
			expect(graph.stage).toBe("pr-42");
		} finally {
			await harness.destroy(bindle)();
		}
	});
});

describe("deployed graph", () => {
	it("deploys once per bindle and reuses the graph", async () => {
		const harness = createTestHarness();
		const bindle = fakeBindle();
		const deploy = harness.deploy(bindle);
		try {
			expect(await deploy()).toBe(await deploy());
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("exposes binding outputs keyed by alias", async () => {
		const harness = createTestHarness();
		const bindle = fakeBindle();
		const graph = await harness.deploy(bindle)();
		try {
			const outputs = graph.outputs<Record<string, { locator: string }>>();
			expect(Object.keys(outputs)).toEqual(["api", "cache", "db"]);
			expect(outputs.db?.locator).toBe("hobo-test://test/data/db");
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("serves http(alias) from the loopback listener", async () => {
		const harness = createTestHarness();
		const bindle = fakeBindle();
		const graph = await harness.deploy(bindle)();
		try {
			const response = await fetch(`${graph.http("api").baseUrl}/hello`);
			expect(response.status).toBe(200);
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("refuses http(alias) for a resource with no listener", async () => {
		const harness = createTestHarness();
		const bindle = fakeBindle();
		const graph = await harness.deploy(bindle)();
		try {
			expect(() => graph.http("db")).toThrow(TestHarnessError);
			try {
				graph.http("db");
			} catch (error) {
				expect((error as TestHarnessError).code).toBe(
					"HARNESS_ENDPOINT_UNAVAILABLE",
				);
			}
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("refuses an unknown alias and names the collected ones", async () => {
		const harness = createTestHarness();
		const bindle = fakeBindle();
		const graph = await harness.deploy(bindle)();
		try {
			graph.resource("nope");
			expect.unreachable("expected a refusal");
		} catch (error) {
			const refusal = error as TestHarnessError;
			expect(refusal.code).toBe("HARNESS_ALIAS_UNKNOWN");
			expect(refusal.remediation).toContain("api");
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("destroy is idempotent and safe before any deploy", async () => {
		const harness = createTestHarness();
		const bindle = fakeBindle();
		await harness.destroy(bindle)();
		await harness.deploy(bindle)();
		await harness.destroy(bindle)();
		await harness.destroy(bindle)();
	});
});

describe("fidelity attestation", () => {
	it("counts every handle by its ADR-0042 label", async () => {
		const harness = createTestHarness();
		const bindle = fakeBindle();
		const graph = await harness.deploy(bindle)();
		try {
			expect(graph.fidelity().byFidelity).toEqual({
				real: 0,
				simulated: 1,
				mocked: 2,
				"camp-only": 0,
			});
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("claims nothing before any assertion touched a handle", async () => {
		const harness = createTestHarness();
		const bindle = fakeBindle();
		const graph = await harness.deploy(bindle)();
		try {
			const report = graph.fidelity();
			expect(report.assertedAgainst).toEqual([]);
			expect(report.prodReadinessClaimable).toBe(true);
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("refuses a prod-readiness claim once a mocked handle is asserted against", async () => {
		const harness = createTestHarness();
		const bindle = fakeBindle();
		const graph = await harness.deploy(bindle)();
		try {
			graph.resource("api");
			expect(graph.fidelity().prodReadinessClaimable).toBe(true);
			graph.resource("db");
			const report = graph.fidelity();
			expect(report.prodReadinessClaimable).toBe(false);
			expect(report.assertedAgainst).toEqual([
				{ alias: "api", fidelity: "simulated" },
				{ alias: "db", fidelity: "mocked" },
			]);
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("counts http(alias) access as an assertion against that handle", async () => {
		const harness = createTestHarness();
		const bindle = fakeBindle();
		const graph = await harness.deploy(bindle)();
		try {
			graph.http("api");
			expect(graph.fidelity().assertedAgainst).toEqual([
				{ alias: "api", fidelity: "simulated" },
			]);
		} finally {
			await harness.destroy(bindle)();
		}
	});
});

describe("harness untilReady", () => {
	it("polls a deployed alias over real HTTP", async () => {
		const harness = createTestHarness();
		const bindle = fakeBindle();
		await harness.deploy(bindle)();
		try {
			const result = await harness.untilReady("api", {
				attempts: 3,
				initialDelayMs: 1,
			});
			expect(result.status).toBe(200);
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("fails fast when the endpoint answers 401", async () => {
		const probe: ReadinessProbe = async () => ({ status: 401 });
		const harness = createTestHarness({}, { probe });
		await expect(
			harness.untilReady("http://127.0.0.1:1/", {
				attempts: 5,
				initialDelayMs: 1,
			}),
		).rejects.toMatchObject({ code: "HARNESS_READINESS_REJECTED" });
	});

	it("retries a 503 and gives up within the attempt budget", async () => {
		let calls = 0;
		const probe: ReadinessProbe = async () => {
			calls += 1;
			return { status: 503 };
		};
		const harness = createTestHarness({}, { probe });
		await expect(
			harness.untilReady("http://127.0.0.1:1/", {
				attempts: 3,
				initialDelayMs: 1,
			}),
		).rejects.toMatchObject({ code: "HARNESS_READINESS_EXHAUSTED" });
		expect(calls).toBe(3);
	});

	it("refuses an alias before anything is deployed", async () => {
		const harness = createTestHarness();
		await expect(harness.untilReady("api")).rejects.toMatchObject({
			code: "HARNESS_ALIAS_UNKNOWN",
		});
	});

	it("refuses a handle that carries no endpoint", async () => {
		const harness = createTestHarness();
		const bindle = fakeBindle();
		const graph = await harness.deploy(bindle)();
		try {
			await expect(
				harness.untilReady(graph.resource("db")),
			).rejects.toMatchObject({ code: "HARNESS_ENDPOINT_UNAVAILABLE" });
		} finally {
			await harness.destroy(bindle)();
		}
	});
});
