import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createComposedHoboCli } from "../src/cli.js";
import { createDoctorCommand } from "../src/doctor-command.js";

// A minimal CommandRunInput: `doctor` only reads `emitProgress`, so the rest is
// present to satisfy the contract shape without exercising it.
function runInput(emit: (m: string) => void) {
	return {
		// SAFETY: assertion required at this I/O or test boundary.
		context: {} as never,
		// SAFETY: assertion required at this I/O or test boundary.
		flags: {} as never,
		// SAFETY: assertion required at this I/O or test boundary.
		args: [] as readonly string[],
		verb: "doctor",
		emitProgress: emit,
	};
}

afterEach(() => vi.unstubAllEnvs());

describe("createDoctorCommand", () => {
	it("does not report ambient provider tokens as usable deployment credentials", async () => {
		const home = mkdtempSync(join(tmpdir(), "hobo-doctor-ambient-"));
		try {
			vi.stubEnv("HOBO_HOME", home);
			vi.stubEnv("HOBO_CREDENTIALS", undefined);
			vi.stubEnv("HOBO_OPENSESAME_CHILD", undefined);
			vi.stubEnv("CLOUDFLARE_API_TOKEN", undefined);
			vi.stubEnv("VERCEL_TOKEN", "ambient-test-token");
			const result = await createDoctorCommand().run(runInput(() => {}));
			expect(result).toMatchObject({
				status: "in-memory",
				data: { backend: "in-memory", live: false },
			});
			expect(result.remediation).toContain(
				"Configure an approved Vercel credential source; plain VERCEL_TOKEN in the process environment is ignored.",
			);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("reports a live Cloudflare target", async () => {
		const progress: string[] = [];
		const command = createDoctorCommand({
			env: { CLOUDFLARE_API_TOKEN: "cf", CLOUDFLARE_ACCOUNT_ID: "acct" },
		});

		const result = await command.run(runInput((m) => progress.push(m)));

		expect(result.ok).toBe(true);
		expect(result.status).toBe("live");
		expect(result.code).toBe("HOBO_DEPLOY_LIVE");
		expect(result.data).toMatchObject({
			command: "doctor",
			backend: "cloudflare",
			live: true,
			identityMigration: {
				continuousDefault: true,
				bindleConfigRequired: false,
				dualFixtures: { dualOracleOk: true },
				canMigrate: { ok: true, dimension: "can-migrate" },
			},
			trails: {
				identityContinuous: {
					bindleConfigRequired: false,
					canTrailOk: true,
					handsOff: true,
				},
				canTrailDimension: "can-trail",
			},
			messaging: {
				daprOptional: true,
				defaultRuntime: "in-process-wasm",
				adr: "ADR-0138",
			},
		});
		expect(progress).toEqual([result.message]);
	});

	it("reports a live Vercel target when only VERCEL_TOKEN is set", async () => {
		const command = createDoctorCommand({ env: { VERCEL_TOKEN: "vc" } });

		const result = await command.run(runInput(() => {}));

		expect(result.status).toBe("live");
		expect(result.data).toMatchObject({
			backend: "vercel",
			live: true,
			identityMigration: {
				continuousDefault: true,
				bindleConfigRequired: false,
			},
		});
	});

	it("reports the in-memory fallback and how to activate each real backend", async () => {
		const command = createDoctorCommand({ env: {} });

		const result = await command.run(runInput(() => {}));

		expect(result.ok).toBe(true);
		expect(result.status).toBe("in-memory");
		expect(result.code).toBe("HOBO_DEPLOY_MOCKED");
		expect(result.remediation).toEqual(
			expect.arrayContaining([
				"Configure an approved Vercel credential source; plain VERCEL_TOKEN in the process environment is ignored.",
				"Configure an approved Cloudflare credential source; plain CLOUDFLARE_API_TOKEN in the process environment is ignored. Set CLOUDFLARE_ACCOUNT_ID for cloudflare.",
			]),
		);
		expect(result.data).toMatchObject({
			backend: "in-memory",
			live: false,
			identityMigration: {
				continuousDefault: true,
				bindleConfigRequired: false,
				dualFixtures: { dualOracleOk: true },
			},
			trails: {
				identityContinuous: { bindleConfigRequired: false, handsOff: true },
			},
		});
	});

	it("reports no code-harness section, since hobo-code is not part of main", async () => {
		// `toMatchObject` above ignores extra keys, so it cannot see a
		// section coming back. Assert the key is absent outright.
		const result = await createDoctorCommand({ env: {} }).run(
			runInput(() => {}),
		);

		expect(result.data).not.toHaveProperty("codeHarness");
		for (const line of result.remediation ?? []) {
			expect(line).not.toMatch(/hobo-code|code harness/iu);
		}
	});

	it("prints no codeHarness key from `hobo doctor --json`", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hobo-doctor-json-"));
		try {
			const result = await createComposedHoboCli().run(["doctor", "--json"], {
				cwd,
			});
			const envelope: { readonly data?: object } = JSON.parse(result.stdout);

			expect(envelope.data).toBeDefined();
			expect(envelope.data).not.toHaveProperty("codeHarness");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("names the single missing Cloudflare var when only one of the pair is set", async () => {
		const command = createDoctorCommand({
			env: { CLOUDFLARE_API_TOKEN: "cf" },
		});

		const result = await command.run(runInput(() => {}));

		expect(result.status).toBe("in-memory");
		expect(result.remediation).toContain(
			"Set CLOUDFLARE_ACCOUNT_ID to deploy for real via cloudflare.",
		);
	});
});
