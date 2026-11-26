/**
 * `hobo identity` — the observe-only continuous identity-migration surface.
 *
 * Continuous identity migration is the promise that a workload can move
 * between identity providers without a cutover and without anything in the
 * Bindle. Starting, linking, and cutting over are Matching/policy-gated
 * platform operations, so this command only observes: `status` and `inspect`.
 *
 * **Zero Bindle config is the product guarantee**, and `bindleConfigRequired:
 * false` in every payload is where it is machine-checkable rather than just
 * documented. A change that made identity migration require manifest fields
 * should fail a test, not arrive as a support question.
 *
 * **No active migration is a normal, reportable state.** A machine with
 * nothing in flight still has the continuous dual path available, so `status`
 * reports `idle` and says so rather than refusing. Treating "nothing here" as
 * an error would make the healthy case look broken.
 *
 * **`inspect` requires an id and matches it exactly.** The stored record
 * belongs to one migration in one tenant. Returning it for any id asked would
 * make a typo look like a successful lookup of a different migration.
 *
 * The injectable service seam distinguishes three states that read the same
 * from outside: no service wired (read the on-disk event log), a service that
 * reports no migration, and a service that has one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IdentityMigrationService } from "@hobo/identity";
import { afterEach, describe, expect, it } from "vitest";

import { HOBO_PROFILE_SCHEMA, saveHoboProfile } from "../src/hobo-profile.js";
import {
	createIdentityCommand,
	persistMigrationEvents,
} from "../src/identity-command.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-identity-"));
	dirs.push(dir);
	return dir;
}

const progress: string[] = [];

async function run(
	args: readonly string[] = [],
	options: {
		readonly flags?: Record<string, unknown>;
		readonly env?: NodeJS.ProcessEnv;
		readonly hoboHome?: string;
		readonly service?: IdentityMigrationService | null;
	} = {},
) {
	progress.length = 0;
	return createIdentityCommand({
		env: options.env ?? {},
		hoboHome: options.hoboHome ?? home(),
		...("service" in options ? { service: options.service } : {}),
	}).run({
		context: { cwd: "/" } as never,
		flags: (options.flags ?? {}) as never,
		args: [...args],
		emitProgress: (line: string) => {
			progress.push(line);
		},
	} as never);
}

describe("subcommand dispatch", () => {
	it("defaults to status", async () => {
		// `hobo identity` alone is "what is happening with my identity?", and a
		// usage error there would make the shortest useful invocation fail.
		expect((await run([])).data as { subcommand: string }).toMatchObject({
			subcommand: "status",
		});
	});

	it("refuses an unknown subcommand, quoting it and listing both real ones", async () => {
		const result = await run(["cutover"]);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_IDENTITY_USAGE");
		expect(result.message).toContain("cutover");
		expect((result.data as { subcommands: string[] }).subcommands).toEqual([
			"status",
			"inspect",
		]);
	});

	it("explains that migration is policy-driven rather than just omitting the verbs", async () => {
		// A user reaching for `start` or `link` needs to learn that there is
		// nothing to run, not that they guessed the wrong name.
		const remediation = ((await run(["start"])).remediation ?? []).join(" ");
		expect(remediation).toContain("Matching/policy-driven");
		expect(remediation).toContain("nothing required in the Bindle");
	});
});

describe("tenant resolution", () => {
	it("prefers a non-empty --tenant flag, then the env, then the profile", async () => {
		// Migrations are scoped by tenant, so looking in the wrong one returns
		// "not found" for a migration that exists — a wrong answer, not an error.
		const dir = home();
		saveHoboProfile(dir, {
			schemaVersion: HOBO_PROFILE_SCHEMA,
			updatedAt: "2026-01-01T00:00:00.000Z",
			session: {
				principal: { kind: "user", id: "user:ada" },
				tenant: "acme",
				token: "tok",
				issuedAt: "2026-01-01T00:00:00.000Z",
			},
		});
		const tenantOf = async (
			flags: Record<string, unknown>,
			env: NodeJS.ProcessEnv,
		) =>
			(
				(await run(["inspect", "missing"], { hoboHome: dir, flags, env }))
					.data as { tenant: string }
			).tenant;
		expect(await tenantOf({ tenant: "flag" }, { HOBO_TENANT: "env" })).toBe(
			"flag",
		);
		expect(await tenantOf({ tenant: "" }, { HOBO_TENANT: "env" })).toBe("env");
		expect(await tenantOf({}, {})).toBe("acme");
		expect(
			(
				(await run(["inspect", "missing"], { hoboHome: home() })).data as {
					tenant: string;
				}
			).tenant,
		).toBe("local");
	});

	it("ignores an empty HOBO_TENANT", async () => {
		expect(
			(
				(
					await run(["inspect", "missing"], {
						hoboHome: home(),
						env: { HOBO_TENANT: "" },
					})
				).data as { tenant: string }
			).tenant,
		).toBe("local");
	});
});

describe("status with nothing in flight", () => {
	it("reports idle and says the dual path is available anyway", async () => {
		// The healthy no-migration case must not read as broken. It is also the
		// place the zero-config promise is stated in prose.
		const result = await run(["status"]);
		expect(result.ok).toBe(true);
		expect(result.status).toBe("idle");
		expect(result.code).toBe("HOBO_IDENTITY_MIGRATION_IDLE");
		expect(result.message).toContain("no active identity migration");
		expect(result.message).toContain("zero Bindle config");
	});

	it("marks itself observe-only and dry-run", async () => {
		// A consumer of this payload has no other way to tell a projection from
		// work that happened.
		const data = (await run(["status"])).data as {
			observeOnly: boolean;
			bindleConfigRequired: boolean;
			canMigrate: { dryRun: boolean; continuousDefault: boolean };
		};
		expect(data.observeOnly).toBe(true);
		expect(data.bindleConfigRequired).toBe(false);
		expect(data.canMigrate.dryRun).toBe(true);
		expect(data.canMigrate.continuousDefault).toBe(true);
	});

	it("reports the dual-fixture adapters and oracle verdict", async () => {
		// The dual path is what makes a migration safe: both providers answer
		// and their claims are compared. Which adapters, and whether the oracle
		// agreed, is the whole basis of the can-migrate verdict.
		const fixtures = (
			(await run(["status"])).data as {
				dualFixtures: {
					sourceAdapter: string;
					targetAdapter: string;
					dualOracleOk: boolean;
					fidelity: unknown;
				};
			}
		).dualFixtures;
		expect(fixtures.sourceAdapter).toBeTruthy();
		expect(fixtures.targetAdapter).not.toBe(fixtures.sourceAdapter);
		expect(typeof fixtures.dualOracleOk).toBe("boolean");
		expect(fixtures.fidelity).toBeDefined();
	});

	it("shows the Matching signal a provider switch would produce", async () => {
		// The point is that nothing in the Bindle triggers a migration — a
		// resource decision does. Showing the derived signal is how that claim
		// is made concrete rather than asserted.
		const signal = (
			(await run(["status"])).data as {
				matchingSignal: {
					tenant: string;
					sourceAdapter: string;
					targetAdapter: string;
				};
			}
		).matchingSignal;
		// The port that produced the decision is deliberately not carried
		// forward — the signal is "this tenant moves from this provider to that
		// one", and which resource happened to trigger it is not part of the
		// migration's identity. Pinned as-is: the tenant and the two adapters
		// are exactly what a migration needs to be started from.
		expect(signal.tenant).toBe("local");
		expect(signal.sourceAdapter).toBeTruthy();
		expect(signal.targetAdapter).not.toBe(signal.sourceAdapter);
	});

	it("emits the same line it returns", async () => {
		const result = await run(["status"]);
		expect(progress).toContain(result.message);
	});
});

describe("status with a migration in flight", () => {
	const record = {
		id: "mig-1",
		state: "ramping",
		rampPercent: 25,
		failedChecks: 0,
	};

	it("reports the migration's state and ramp as the command's own status", async () => {
		// `ok` says the observation succeeded; `status` says what the migration
		// is doing. Collapsing them would make a healthy ramp indistinguishable
		// from an idle machine.
		const result = await run(["status"], {
			service: {
				snapshot: () => record,
			} as unknown as IdentityMigrationService,
		});
		expect(result.ok).toBe(true);
		expect(result.code).toBe("HOBO_IDENTITY_MIGRATION_ACTIVE");
		expect(result.message).toContain("mig-1");
		expect(result.message).toContain("25%");
	});

	it("treats a service reporting nothing as idle", async () => {
		// A wired service that has no migration is a different code path from no
		// service at all, and both are legitimately idle.
		const result = await run(["status"], {
			service: {
				snapshot: () => null,
			} as unknown as IdentityMigrationService,
		});
		expect(result.status).toBe("idle");
	});

	it("reads the on-disk event log when no service is wired", async () => {
		// The platform writes events; the CLI is read-mostly. A command that only
		// consulted an injected service would show nothing on a real machine.
		const dir = home();
		persistMigrationEvents(dir, []);
		const result = await run(["status"], { hoboHome: dir });
		expect(result.ok).toBe(true);
	});
});

describe("inspect", () => {
	const record = {
		id: "mig-1",
		state: "ramping",
		rampPercent: 25,
		failedChecks: 2,
	};
	const service = {
		snapshot: () => record,
	} as unknown as IdentityMigrationService;

	it("requires a migration id", async () => {
		// Defaulting to "the one migration" would make a mistyped command report
		// on something the user did not ask about.
		for (const args of [["inspect"], ["inspect", ""]]) {
			const result = await run(args, { service });
			expect(result.ok).toBe(false);
			expect(result.code).toBe("HOBO_IDENTITY_INSPECT_USAGE");
			expect((result.remediation ?? []).join(" ")).toContain(
				"hobo identity status",
			);
		}
	});

	it("refuses an id that does not match the stored record", async () => {
		// The record belongs to one migration. Returning it for any id asked
		// would make a typo look like a successful lookup of another migration.
		const result = await run(["inspect", "mig-other"], { service });
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_IDENTITY_MIGRATION_NOT_FOUND");
		expect(result.message).toContain("mig-other");
		expect((result.data as { migrationId: string }).migrationId).toBe(
			"mig-other",
		);
	});

	it("names the tenant it searched in the refusal", async () => {
		// A migration missing *in this tenant* is a different problem from one
		// that does not exist. Without the tenant the message cannot say which.
		const result = await run(["inspect", "mig-other"], {
			service,
			flags: { tenant: "acme" },
		});
		expect(result.message).toContain("acme");
		expect((result.data as { tenant: string }).tenant).toBe("acme");
	});

	it("refuses when there is no record at all, not only when the id differs", async () => {
		const result = await run(["inspect", "mig-1"], { service: null });
		expect(result.code).toBe("HOBO_IDENTITY_MIGRATION_NOT_FOUND");
	});

	it("returns the migration view with the can-migrate verdict beside it", async () => {
		// The verdict is about whether the move is safe *now*; the view is what
		// has happened so far. An operator deciding whether to let a ramp
		// continue needs both in one answer.
		const result = await run(["inspect", "mig-1"], { service });
		expect(result.ok).toBe(true);
		expect(result.status).toBe("ramping");
		expect(result.code).toBe("HOBO_IDENTITY_MIGRATION");
		const data = result.data as {
			migration: unknown;
			canMigrate: unknown;
			bindleConfigRequired: boolean;
		};
		expect(data.migration).toBeDefined();
		expect(data.canMigrate).toBeDefined();
		expect(data.bindleConfigRequired).toBe(false);
	});

	it("emits a progress line carrying the ramp and the failed dual checks", async () => {
		// Failed dual checks are the signal that the two providers disagree,
		// which is exactly when a ramp should stop. It belongs in the streamed
		// line, not only in the payload.
		await run(["inspect", "mig-1"], { service });
		expect(progress.join(" ")).toContain("ramp=25%");
		expect(progress.join(" ")).toContain("dual-failed=2");
	});
});
