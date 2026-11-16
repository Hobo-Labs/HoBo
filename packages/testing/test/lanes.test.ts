import { describe, expect, it } from "vitest";
import {
	CAMP_CREDENTIAL_ENV_VAR,
	createTestHarness,
	deployInProcess,
	destroyInProcess,
	parseEphemeralCampTarget,
	type TestHarnessError,
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
			const refusal = error as TestHarnessError;
			expect(refusal.code).toBe("HARNESS_YARD_REQUIRED");
			expect(refusal.remediation).toContain("never falls back to in-process");
		}
	});

	it("refuses a value that is not a parsed Yard", () => {
		try {
			parseEphemeralCampTarget({ name: "yard:aws" }, CAMP_ENV);
			expect.unreachable("expected a refusal");
		} catch (error) {
			expect((error as TestHarnessError).code).toBe("HARNESS_YARD_INVALID");
		}
	});

	it("refuses when no brokered credential locator is present", () => {
		try {
			parseEphemeralCampTarget(YARD_LIKE, { VITEST: "true" });
			expect.unreachable("expected a refusal");
		} catch (error) {
			const refusal = error as TestHarnessError;
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
			expect((error as TestHarnessError).code).toBe(
				"HARNESS_CREDENTIAL_NOT_A_REF",
			);
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

	it("refuses at deploy rather than serving an in-process graph", async () => {
		const harness = createTestHarness(
			{ lane: "ephemeral-camp", yard: YARD_LIKE },
			{ env: CAMP_ENV },
		);
		await expect(harness.deploy(fakeBindle())()).rejects.toMatchObject({
			code: "HARNESS_LANE_UNIMPLEMENTED",
		});
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
			expect(deployment.handles.get("db")?.fidelity).toBe("mocked");
			expect(deployment.handles.get("db")?.endpoint).toBeUndefined();
			expect(deployment.handles.get("cache")?.fidelity).toBe("mocked");
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
				"db" as never,
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
