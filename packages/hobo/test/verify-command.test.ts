import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CliContext } from "@hobo/cli";

import { definePolicyRule, type PolicyPack } from "@hobo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createVerifyCommand } from "../src/verify-command.js";

// `hobo verify` drives the REAL @hobo/contracts Gatekeeper over the project's
// Bindle. These tests exercise the wired engine end to end: the permissive lane
// allows and records a decision, a seeded low quota denies with a machine-
// readable cost reason, a deny policy pack denies with a policy reason, and a
// missing Bindle is a clean typed error (not a stub).

const HELLO_BINDLE = {
	schema: "hobo.manifest/v1",
	componentHost: { kind: "wasmtime", version: "1.0.0" },
	resources: {
		service: {
			type: "component.v1",
			image: "oci://registry.example.com/hello-bindle@sha256:abc123",
			runtime: "wasm",
			exports: ["wasi:http/incoming-handler"],
			bind: ["sessions"],
		},
		sessions: { type: "data.v1", port: "kv" },
	},
};

async function withProject(
	callback: (cwd: string) => Promise<void>,
	writeManifest = true,
): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-verify-"));
	if (writeManifest) {
		await writeFile(
			path.join(dir, "hobo.bindle.json"),
			`${JSON.stringify(HELLO_BINDLE, null, 2)}\n`,
		);
	}
	try {
		await callback(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function runInput(cwd: string) {
	return {
		// SAFETY: assertion required at this I/O or test boundary.
		context: { cwd, projectDir: cwd } as CliContext,
		// SAFETY: assertion required at this I/O or test boundary.
		flags: { cwd } as never,
		// SAFETY: assertion required at this I/O or test boundary.
		args: [] as readonly string[],
		verb: "verify",
		emitProgress: () => {},
	};
}

afterEach(() => {});

describe("createVerifyCommand", () => {
	it("allows the hello-bindle on the permissive default lane", async () => {
		await withProject(async (cwd) => {
			const result = await createVerifyCommand().run(runInput(cwd));

			expect(result.ok).toBe(true);
			expect(result.status).toBe("allow");
			expect(result.code).toBe("HOBO_GATEKEEPER_ALLOW");
			expect(result.remediation).toBeUndefined();
			expect(result.data).toMatchObject({
				command: "verify",
				decision: "allow",
			});
			// The cost gate saw both resources against the default budget.
			expect(
				// SAFETY: assertion required at this I/O or test boundary.
				(result.data as { costQuota: { requested: number } }).costQuota
					.requested,
			).toBe(2);
		});
	});

	it("denies with a machine-readable cost reason when the quota is exceeded", async () => {
		await withProject(async (cwd) => {
			const result = await createVerifyCommand({ costLimit: 1 }).run(
				runInput(cwd),
			);

			expect(result.ok).toBe(false);
			expect(result.status).toBe("deny");
			expect(result.code).toBe("HOBO_GATEKEEPER_DENY");
			expect(result.remediation?.some((r) => r.includes("[cost]"))).toBe(true);
			expect(
				result.remediation?.some((r) => r.includes("quota-exceeded")),
			).toBe(true);
		});
	});

	it("denies with a policy reason when the injected pack denies the deploy", async () => {
		const denyPack: PolicyPack = {
			id: "deny-all",
			version: "1.0.0",
			rules: [
				definePolicyRule({
					id: "deny-deploy",
					when: (request) => request.action === "deploy",
					decide: () => ({
						effect: "deny",
						reason: "deploys are blocked in this pack",
					}),
				}),
			],
		};

		await withProject(async (cwd) => {
			const result = await createVerifyCommand({ policyPack: denyPack }).run(
				runInput(cwd),
			);

			expect(result.ok).toBe(false);
			expect(result.status).toBe("deny");
			expect(result.remediation?.some((r) => r.includes("[policy]"))).toBe(
				true,
			);
		});
	});

	it("returns a clean typed error (not a stub) when there is no Bindle", async () => {
		await withProject(async (cwd) => {
			const result = await createVerifyCommand().run(runInput(cwd));
			expect(result.ok).toBe(false);
			expect(result.status).toBe("no_bindle");
			expect(result.code).toBe("HOBO_NO_BINDLE");
			expect(result.code).not.toBe("HOBO_CLI_STUB");
		}, false);
	});
});

describe("residency dimension (ADR-0146)", () => {
	const euPii = {
		classifications: ["pii" as const],
		allowedJurisdictions: ["eu" as const],
	};

	it("blocks a pii-classified plan landing outside the allowed jurisdiction", async () => {
		await withProject(async (cwd) => {
			const result = await createVerifyCommand({
				residency: { constraint: euPii, region: "us-east-1" },
			}).run(runInput(cwd));

			expect(result.ok).toBe(false);
			expect(result.status).toBe("deny");
			expect(
				result.remediation?.some((entry) =>
					entry.includes("[residency] jurisdiction-not-allowed"),
				),
			).toBe(true);
		});
	});

	it("allows when the plan region sits inside the allowed jurisdiction", async () => {
		await withProject(async (cwd) => {
			const result = await createVerifyCommand({
				residency: { constraint: euPii, region: "eu-west-1" },
			}).run(runInput(cwd));

			expect(result.ok).toBe(true);
			expect(result.status).toBe("allow");
		});
	});

	it("fails closed on an unattested region (no region provided)", async () => {
		await withProject(async (cwd) => {
			const result = await createVerifyCommand({
				residency: { constraint: euPii },
			}).run(runInput(cwd));

			expect(result.ok).toBe(false);
			expect(
				result.remediation?.some((entry) =>
					entry.includes("[residency] region-unmapped"),
				),
			).toBe(true);
		});
	});
});

describe("residency from the environment (C9: the shipped CLI runs the dimension)", () => {
	const saved: Record<string, string | undefined> = {};
	const KEYS = [
		"HOBO_RESIDENCY_ALLOW",
		"HOBO_RESIDENCY_DENY",
		"HOBO_RESIDENCY_CLASSIFICATIONS",
		"HOBO_REGION",
	];
	beforeEach(() => {
		for (const key of KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	});
	afterEach(() => {
		for (const key of KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	it("denies through default deps when env pins pii to eu and the region is us", async () => {
		process.env.HOBO_RESIDENCY_ALLOW = "eu";
		process.env.HOBO_RESIDENCY_CLASSIFICATIONS = "pii";
		process.env.HOBO_REGION = "us-east-1";
		await withProject(async (cwd) => {
			const result = await createVerifyCommand().run(runInput(cwd));
			expect(result.ok).toBe(false);
			expect(
				result.remediation?.some((entry) => entry.includes("[residency]")),
			).toBe(true);
		});
	});

	it("warns (still allows) for unregulated data outside the jurisdiction", async () => {
		process.env.HOBO_RESIDENCY_ALLOW = "eu";
		process.env.HOBO_RESIDENCY_CLASSIFICATIONS = "internal";
		process.env.HOBO_REGION = "us-east-1";
		await withProject(async (cwd) => {
			const result = await createVerifyCommand().run(runInput(cwd));
			expect(result.ok).toBe(true);
			expect(result.status).toBe("allow");
		});
	});

	it("fails closed with a typed config error on an invalid jurisdiction id", async () => {
		process.env.HOBO_RESIDENCY_ALLOW = "atlantis";
		await withProject(async (cwd) => {
			const result = await createVerifyCommand().run(runInput(cwd));
			expect(result.ok).toBe(false);
			expect(result.code).toBe("HOBO_RESIDENCY_CONFIG");
		});
	});
});
