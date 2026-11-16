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
				throw new Error(`apply failed for ${program.resourceId}`);
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
