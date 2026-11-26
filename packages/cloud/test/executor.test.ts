import { describe, expect, it } from "vitest";

import {
	AMBIENT_CREDENTIAL_KEYS,
	createInProcessCredentialBroker,
	createInProcessExecutor,
	credentialScope,
	type IacProgram,
	type IacProvider,
} from "../src/index.js";

// S2-03b: the Executor sandbox contract. Full Firecracker is out of scope; this
// in-process backend enforces the same invariants deterministically — creds only
// via the injected scoped token, no ambient cloud creds, egress bounded to an
// allowlist — and streams exec.* facts through a terminal exec.Succeeded/Failed.

function mockIac(opts: { failApply?: string[] } = {}): IacProvider {
	const fail = new Set(opts.failApply ?? []);
	return {
		id: "mock-local-container",
		async preview(program) {
			return { summary: `preview ${program.resourceId}`, changes: 1 };
		},
		async apply(program) {
			if (fail.has(program.resourceId))
				throw Object.assign(
					new Error(`apply failed for ${program.resourceId}`),
					{ requiresReconciliation: false, executionOutcome: "not-started" },
				);
			return {
				endpoint: `${program.resourceId}.local`,
				stack: program.stackName,
			};
		},
		async destroy() {
			/* no-op local backend */
		},
		async refresh() {
			return { drift: false, observed: {} };
		},
	};
}

function program(overrides: Partial<IacProgram> = {}): IacProgram {
	return {
		programId: "deploy-1:api",
		deploymentId: "deploy-1",
		resourceId: "api",
		provider: "@hobo/provider-local",
		driver: "pulumi",
		action: "apply",
		stackName: "tenant-a/deploy-1/api",
		...overrides,
	};
}

const broker = createInProcessCredentialBroker();
function cred(resourceId = "api") {
	return broker.issue({
		scope: credentialScope({
			tenant: "tenant-a",
			resourceId,
			driver: "pulumi",
			action: "apply",
		}),
	});
}

describe("Executor: sandboxed preview+apply against an injected IacProvider", () => {
	it.each([
		"apply",
		"destroy",
	] as const)("requires reconciliation for an unclassified %s error after dispatch", async (action) => {
		const iac = mockIac();
		iac[action] = async () => {
			throw new Error("response lost after provider effect");
		};
		const result = await createInProcessExecutor({ iac }).run(
			program({ action }),
			cred(),
		);
		expect(result).toMatchObject({
			status: "failed",
			classification: "fatal",
			requiresReconciliation: true,
			reconciliationOperation: action,
		});
	});

	it("does not infer a provider effect from a preview failure", async () => {
		const iac = mockIac();
		iac.preview = async () => {
			throw new Error("preview unavailable");
		};
		const result = await createInProcessExecutor({ iac }).run(
			program(),
			cred(),
		);
		expect(result).toMatchObject({
			status: "failed",
			classification: "retryable",
		});
		expect(result).not.toHaveProperty("requiresReconciliation", true);
	});

	it("keeps an identified reservation uncertain even if an error claims no execution", async () => {
		const iac = mockIac();
		iac.apply = async () => {
			throw Object.assign(new Error("admission disputed"), {
				requiresReconciliation: false,
				executionOutcome: "not-started",
				reservationId: "iac:held",
			});
		};
		const result = await createInProcessExecutor({ iac }).run(
			program(),
			cred(),
		);
		expect(result).toMatchObject({
			status: "failed",
			requiresReconciliation: true,
			reservationId: "iac:held",
		});
	});
	it("requires reconciliation when a provider error cannot be inspected", async () => {
		const iac = mockIac();
		iac.apply = async () => {
			throw Object.defineProperty(
				new Error("failed"),
				"requiresReconciliation",
				{
					get() {
						throw new Error("unreadable");
					},
				},
			);
		};
		const result = await createInProcessExecutor({ iac }).run(
			program(),
			cred(),
		);
		expect(result).toMatchObject({
			status: "failed",
			classification: "fatal",
			requiresReconciliation: true,
			reconciliationOperation: "apply",
		});
	});
	it("requires reconciliation instead of retrying an ambiguous provider outcome", async () => {
		const iac = mockIac();
		iac.apply = async () => {
			throw Object.assign(
				new Error("provider outcome requires reconciliation"),
				{
					requiresReconciliation: true,
					reservationId: "iac:reservation-1",
				},
			);
		};
		const result = await createInProcessExecutor({ iac }).run(
			program(),
			cred(),
		);
		expect(result).toMatchObject({
			status: "failed",
			classification: "fatal",
			requiresReconciliation: true,
			reservationId: "iac:reservation-1",
			reconciliationOperation: "apply",
		});
		expect(result.events.at(-1)?.data).toMatchObject({
			requiresReconciliation: true,
			reservationId: "iac:reservation-1",
			reconciliationOperation: "apply",
		});
	});
	it("does not apply or destroy a preview-only program", async () => {
		let calls = 0;
		const iac = mockIac();
		iac.apply = async () => {
			calls++;
			return {};
		};
		iac.destroy = async () => {
			calls++;
		};
		const result = await createInProcessExecutor({ iac }).run(
			program({ action: "preview" }),
			cred(),
		);
		expect(result.status).toBe("succeeded");
		expect(calls).toBe(0);
	});
	it("runs preview then apply and streams a terminal exec.Succeeded with outputs", async () => {
		const executor = createInProcessExecutor({ iac: mockIac() });
		const result = await executor.run(program(), cred());

		expect(result.status).toBe("succeeded");
		if (result.status !== "succeeded") return;
		expect(result.events.map((e) => e.type)).toEqual([
			"exec.Started",
			"exec.Output",
			"exec.Diff",
			"exec.Succeeded",
		]);
		expect(result.outputs.endpoint).toBe("api.local");
		expect(result.sandbox.ambientCredentials).toBe(false);
		expect(result.sandbox.backend).toBe("in-process");
	});

	it("classifies an apply error as retryable and emits exec.Failed", async () => {
		const executor = createInProcessExecutor({
			iac: mockIac({ failApply: ["api"] }),
		});
		const result = await executor.run(program(), cred());
		expect(result.status).toBe("failed");
		if (result.status !== "failed") return;
		expect(result.classification).toBe("retryable");
		expect(result.events.at(-1)?.type).toBe("exec.Failed");
	});
});

describe("Executor sandbox hardening (S2-03b): no ambient credentials", () => {
	it("refuses fatally when any ambient cloud credential is visible to the run", async () => {
		const executor = createInProcessExecutor({ iac: mockIac() });
		// Ambient creds are proven absent by contract: passing them in makes the run
		// fail fatally; the only permitted credential is the injected scoped token.
		const result = await executor.run(program(), cred(), {
			ambientEnv: {
				AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
				CLOUDFLARE_API_TOKEN: "cf-secret",
			},
		});
		expect(result.status).toBe("failed");
		if (result.status !== "failed") return;
		expect(result.classification).toBe("fatal");
		expect(result.reason).toContain("sandbox.ambient_credentials");
		expect(result.reason).toContain("AWS_ACCESS_KEY_ID");
		expect(result.reason).toContain("CLOUDFLARE_API_TOKEN");
	});

	it("succeeds with a clean sandbox and never carries ambient credentials", async () => {
		const executor = createInProcessExecutor({ iac: mockIac() });
		const result = await executor.run(program(), cred(), { ambientEnv: {} });
		expect(result.status).toBe("succeeded");
		expect(result.sandbox.ambientCredentials).toBe(false);
		// The known cloud cred env vars the sandbox actively scans for.
		expect(AMBIENT_CREDENTIAL_KEYS).toContain("PULUMI_ACCESS_TOKEN");
	});

	it("proves the injected credential is scoped and non-ambient", () => {
		const c = cred("database");
		expect(c.ambient).toBe(false);
		expect(c.scope).toBe(
			"tenant:tenant-a/resource:database/job:pulumi/action:apply",
		);
		expect(c.ttlSeconds).toBeGreaterThan(0);
	});
});

describe("Executor sandbox hardening (S2-03b): bounded egress", () => {
	it("denies undeclared egress fatally", async () => {
		const executor = createInProcessExecutor({
			iac: mockIac(),
			allowedEgress: ["https://registry.local"],
		});
		const result = await executor.run(program(), cred(), {
			egressAttempts: [{ target: "https://attacker.example/exfiltrate" }],
		});
		expect(result.status).toBe("failed");
		if (result.status !== "failed") return;
		expect(result.classification).toBe("fatal");
		expect(result.reason).toContain("sandbox.egress_scope");
	});

	it("allows egress on the allowlist", async () => {
		const executor = createInProcessExecutor({
			iac: mockIac(),
			allowedEgress: ["https://registry.local"],
		});
		const result = await executor.run(program(), cred(), {
			egressAttempts: [{ target: "https://registry.local" }],
		});
		expect(result.status).toBe("succeeded");
	});
});
