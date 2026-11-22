import { parseResourceId } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	CAMP_CREDENTIAL_ENV_VAR,
	createTestHarness,
	deployInProcess,
	destroyInProcess,
	type EphemeralCampDeployRequest,
	type EphemeralCampDriver,
	parseEphemeralCampTarget,
	TestHarnessError,
} from "../src/index.js";
import { CAMP_ENV, fakeBindle, YARD_LIKE } from "./fixtures.js";

describe("ephemeral-camp lane gates", () => {
	it("names the credential environment contract", () => {
		expect(CAMP_CREDENTIAL_ENV_VAR).toBe("HOBO_TESTING_CAMP_CREDENTIAL_REF");
	});

	it("refuses without a Yard and does not downgrade to in-process", () => {
		try {
			createTestHarness({ lane: "ephemeral-camp" }, { env: CAMP_ENV });
			expect.unreachable("expected a refusal");
		} catch (error) {
			if (!(error instanceof TestHarnessError)) throw error;
			const refusal = error;
			expect(refusal.code).toBe("HARNESS_YARD_REQUIRED");
			expect(refusal.remediation).toContain("never falls back to in-process");
		}
	});

	it("refuses a value that is not a parsed Yard", () => {
		try {
			parseEphemeralCampTarget({ name: "yard:aws" }, CAMP_ENV);
			expect.unreachable("expected a refusal");
		} catch (error) {
			if (!(error instanceof TestHarnessError)) throw error;
			expect(error.code).toBe("HARNESS_YARD_INVALID");
		}
	});

	it("refuses when no brokered credential locator is present", () => {
		try {
			parseEphemeralCampTarget(YARD_LIKE, { VITEST: "true" });
			expect.unreachable("expected a refusal");
		} catch (error) {
			if (!(error instanceof TestHarnessError)) throw error;
			const refusal = error;
			expect(refusal.code).toBe("HARNESS_CREDENTIALS_REQUIRED");
			expect(refusal.remediation).toContain("never degrades to in-process");
		}
	});

	it("refuses a pasted credential value in place of a locator", () => {
		try {
			parseEphemeralCampTarget(YARD_LIKE, {
				HOBO_TESTING_CAMP_CREDENTIAL_REF: "AKIAIOSFODNN7EXAMPLE",
			});
			expect.unreachable("expected a refusal");
		} catch (error) {
			if (!(error instanceof TestHarnessError)) throw error;
			expect(error.code).toBe("HARNESS_CREDENTIAL_NOT_A_REF");
		}
	});

	it("accepts an explicit Yard plus a brokered locator", () => {
		const target = parseEphemeralCampTarget(YARD_LIKE, CAMP_ENV);
		expect(target).toEqual({
			yardName: "yard:aws",
			providerId: "aws",
			credentialRef: "hobo-secret://tenant-1/yard-aws/deploy",
		});
		expect(Object.isFrozen(target)).toBe(true);
	});

	it("requires a Camp driver", async () => {
		const harness = createTestHarness(
			{ lane: "ephemeral-camp", yard: YARD_LIKE },
			{ env: CAMP_ENV },
		);
		await expect(harness.deploy(fakeBindle())()).rejects.toMatchObject({
			code: "HARNESS_CAMP_DRIVER_REQUIRED",
		});
	});

	it("deploys and destroys real Camp resources through the driver", async () => {
		const requests: EphemeralCampDeployRequest[] = [];
		let destroyed = 0;
		const campDriver: EphemeralCampDriver = {
			async deploy(request) {
				requests.push(request);
				return {
					resources: [
						{
							alias: "api",
							kind: "api",
							endpoint: "https://pr-42.example.test",
						},
						{ alias: "db", kind: "data" },
						{ alias: "cache", kind: "kv" },
					],
					outputs: {
						api: { endpoint: "https://pr-42.example.test" },
						db: { locator: "postgres://brokered" },
						cache: { locator: "redis://brokered" },
					},
					async destroy() {
						destroyed += 1;
					},
				};
			},
		};
		const bindle = fakeBindle();
		const harness = createTestHarness(
			{
				lane: "ephemeral-camp",
				stage: "pr-42",
				yard: YARD_LIKE,
				campDriver,
			},
			{ env: CAMP_ENV },
		);
		const graph = await harness.deploy(bindle)();
		expect(requests).toEqual([
			expect.objectContaining({
				bindle,
				stage: "pr-42",
				yardName: "yard:aws",
				providerId: "aws",
				credentialRef: "hobo-secret://tenant-1/yard-aws/deploy",
			}),
		]);
		expect(graph.lane).toBe("ephemeral-camp");
		expect(graph.http("api").baseUrl).toBe("https://pr-42.example.test");
		expect(graph.resource("db").fidelity).toBe("real");
		expect(graph.outputs()).toEqual({
			api: { endpoint: "https://pr-42.example.test" },
			db: { locator: "postgres://brokered" },
			cache: { locator: "redis://brokered" },
		});
		expect(graph.fidelity()).toMatchObject({
			byFidelity: { real: 3, simulated: 0, mocked: 0, "camp-only": 0 },
			prodReadinessClaimable: true,
		});
		await harness.destroy(bindle)();
		expect(destroyed).toBe(1);
	});

	it("destroys an invalid driver deployment", async () => {
		let destroyed = 0;
		const campDriver: EphemeralCampDriver = {
			async deploy() {
				return {
					resources: [{ alias: "api", kind: "wrong" }],
					outputs: {},
					async destroy() {
						destroyed += 1;
					},
				};
			},
		};
		const harness = createTestHarness(
			{ lane: "ephemeral-camp", yard: YARD_LIKE, campDriver },
			{ env: CAMP_ENV },
		);
		await expect(harness.deploy(fakeBindle())()).rejects.toMatchObject({
			code: "HARNESS_CAMP_DEPLOYMENT_INVALID",
		});
		expect(destroyed).toBe(1);
	});
});

describe("in-process lane", () => {
	it("opens a real loopback listener for a resolved entrypoint", async () => {
		const deployment = await deployInProcess(fakeBindle(), "test");
		try {
			const handle = deployment.handles.get("api");
			expect(handle?.fidelity).toBe("simulated");
			expect(handle?.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
			const response = await fetch(`${handle?.endpoint}/`);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe("ok");
		} finally {
			await destroyInProcess(deployment);
		}
	});

	it("labels resources with no engine behind them as mocked", async () => {
		const deployment = await deployInProcess(fakeBindle(), "test");
		try {
			expect(deployment.handles.get("db")?.fidelity).toBe("simulated");
			expect(deployment.handles.get("db")?.endpoint).toBeUndefined();
			expect(deployment.handles.get("cache")?.fidelity).toBe("simulated");
		} finally {
			await destroyInProcess(deployment);
		}
	});

	it("labels container/wasm-component handles camp-only", async () => {
		const deployment = await deployInProcess(
			fakeBindle({
				resources: {
					box: { kind: "container" },
					comp: { kind: "wasm-component" },
				},
				handlers: {},
			}),
			"test",
		);
		try {
			expect(deployment.handles.get("box")?.fidelity).toBe("camp-only");
			expect(deployment.handles.get("comp")?.fidelity).toBe("camp-only");
		} finally {
			await destroyInProcess(deployment);
		}
	});

	it("resolves bindings through runtime-local's local binding resolver", async () => {
		const deployment = await deployInProcess(fakeBindle(), "test");
		try {
			const resolved = await deployment.resolver.resolve(
				parseResourceId("db"),
				"locator",
			);
			expect(resolved).toEqual({
				value: "hobo-test://test/data/db",
				source: "runtime-local",
			});
		} finally {
			await destroyInProcess(deployment);
		}
	});

	it("destroys in reverse dependency order", async () => {
		const deployment = await deployInProcess(fakeBindle(), "test");
		const order = await destroyInProcess(deployment);
		expect(order).toEqual(["api", "db", "cache"]);
	});
});
