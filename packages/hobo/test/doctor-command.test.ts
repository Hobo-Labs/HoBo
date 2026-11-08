import { describe, expect, it } from "vitest";

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

describe("createDoctorCommand", () => {
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
				"Set VERCEL_TOKEN to deploy for real via vercel.",
				"Set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID to deploy for real via cloudflare.",
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
