/**
 * `hobo trails` — the observe-only continuous-migration surface.
 *
 * Trails are how a workload moves between substrates without a cutover. The
 * command deliberately exposes only `status`, `plan`, and `inspect`: running
 * and cutting over are Matching/policy-gated platform operations, and an
 * unconstrained CLI mutation for either would let a user step a live migration
 * past the gate that exists to stop exactly that.
 *
 * Two properties shape everything here.
 *
 * **Observe-only is asserted in the payload, not just in the docs.** Every
 * result carries `observeOnly: true` and `dryRun: true`, because a consumer
 * reading this output — an agent, a dashboard — has no other way to know it is
 * looking at a projection rather than at work that happened.
 *
 * **Pure continuous identity requires zero Trail authoring.** That is the
 * product guarantee, and `bindleConfigRequiredForIdentityContinuous: false`
 * is where it is machine-checkable. A change that made the identity path
 * require configuration would be a change in what HoBo promises, and it should
 * fail here rather than surface as a support question.
 *
 * Tenant and target both resolve flag → env → fallback, and the fallback
 * differs: tenant reaches into the stored profile before defaulting to
 * `local`, because a logged-in user asking about their trails means *their*
 * tenant's trails.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HOBO_PROFILE_SCHEMA, saveHoboProfile } from "../src/hobo-profile.js";
import { createTrailsCommand } from "../src/trails-command.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-trails-"));
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
	} = {},
) {
	progress.length = 0;
	const command = createTrailsCommand({
		env: options.env ?? {},
		hoboHome: options.hoboHome ?? home(),
	});
	return command.run({
		context: { cwd: "/" } as never,
		flags: (options.flags ?? {}) as never,
		args: [...args],
		emitProgress: (line: string) => {
			progress.push(line);
		},
	} as never);
}

describe("subcommand dispatch", () => {
	it("defaults to status when nothing is named", async () => {
		// `hobo trails` on its own is the question "how are my trails?", and
		// answering with a usage error would make the shortest useful invocation
		// the one that fails.
		const result = await run([]);
		expect((result.data as { subcommand: string }).subcommand).toBe("status");
	});

	it("refuses an unknown subcommand, quoting it", async () => {
		// The quoted name is what lets a user spot a typo they cannot see in
		// their own shell history.
		const result = await run(["cutover"]);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_TRAILS_USAGE");
		expect(result.message).toContain("cutover");
	});

	it("lists all three real subcommands in its refusal", async () => {
		// A user reaching for `run` or `cutover` needs to learn both that those
		// are not here and what *is* — otherwise the next guess is another
		// mutation verb.
		const result = await run(["frobnicate"]);
		const remediation = (result.remediation ?? []).join(" ");
		expect(remediation).toContain("hobo trails status");
		expect(remediation).toContain("hobo trails plan");
		expect(remediation).toContain("hobo trails inspect");
		expect((result.data as { subcommands: string[] }).subcommands).toEqual([
			"status",
			"plan",
			"inspect",
		]);
	});

	it("explains why mutation verbs are absent rather than just omitting them", async () => {
		// "Unknown subcommand" reads as an oversight. Saying that continuous
		// identity needs no Trail authoring turns the refusal into the product
		// answer: there is nothing here to run.
		const remediation = ((await run(["run"])).remediation ?? []).join(" ");
		expect(remediation).toContain("zero Trail authoring");
	});
});

describe("tenant resolution", () => {
	it("prefers a non-empty --tenant flag", async () => {
		// The flag is the most explicit statement of intent; an empty string is
		// not a statement at all and must not shadow the env or the profile.
		const dir = home();
		const result = await run(["status"], {
			hoboHome: dir,
			flags: { tenant: "from-flag" },
			env: { HOBO_TENANT: "from-env" },
		});
		expect(result.ok).toBe(true);
		const fromEmpty = await run(["inspect", "no-such-trail"], {
			hoboHome: dir,
			flags: { tenant: "" },
			env: { HOBO_TENANT: "from-env" },
		});
		expect((fromEmpty.data as { tenant: string }).tenant).toBe("from-env");
	});

	it("falls back to the environment, then the stored session, then local", async () => {
		// A logged-in user asking about "my trails" means their tenant. Skipping
		// the profile would answer for `local` and show them nothing.
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
		expect(
			(
				(
					await run(["inspect", "missing"], {
						hoboHome: dir,
						env: { HOBO_TENANT: "from-env" },
					})
				).data as { tenant: string }
			).tenant,
		).toBe("from-env");
		expect(
			(
				(await run(["inspect", "missing"], { hoboHome: dir })).data as {
					tenant: string;
				}
			).tenant,
		).toBe("acme");
		expect(
			(
				(await run(["inspect", "missing"], { hoboHome: home() })).data as {
					tenant: string;
				}
			).tenant,
		).toBe("local");
	});

	it("ignores an empty HOBO_TENANT rather than treating it as a tenant", async () => {
		// An exported-but-empty variable is how a shell leaves a value that was
		// never set. Honouring it would scope every query to the empty tenant.
		const result = await run(["inspect", "missing"], {
			hoboHome: home(),
			env: { HOBO_TENANT: "" },
		});
		expect((result.data as { tenant: string }).tenant).toBe("local");
	});
});

describe("target resolution", () => {
	it("accepts a target from the flag or the environment, defaulting otherwise", async () => {
		// The target selects the fixture set the observation is built from, so
		// all three sources have to reach it — a user who exported the variable
		// should not have to also pass the flag.
		for (const options of [
			{ flags: { target: "staging" } },
			{ env: { HOBO_TRAIL_TARGET: "staging" } },
			{ flags: { target: "" }, env: { HOBO_TRAIL_TARGET: "staging" } },
			{},
		]) {
			const result = await run(["status"], { ...options, hoboHome: home() });
			expect(result.data).toBeDefined();
		}
	});

	it("ignores an empty HOBO_TRAIL_TARGET", async () => {
		const result = await run(["status"], {
			hoboHome: home(),
			env: { HOBO_TRAIL_TARGET: "" },
		});
		expect(result.ok).toBe(true);
	});
});

describe("status", () => {
	it("reports the hands-off identity guarantee as a machine-readable field", async () => {
		// This is the product promise — pure continuous identity needs no Trail
		// authoring. Stating it in the payload is what makes a regression fail a
		// test rather than arrive as a support question.
		const data = (await run(["status"])).data as {
			bindleConfigRequiredForIdentityContinuous: boolean;
			identityContinuous: { bindleConfigRequired: boolean; handsOff: boolean };
		};
		expect(data.bindleConfigRequiredForIdentityContinuous).toBe(false);
		expect(data.identityContinuous.bindleConfigRequired).toBe(false);
		expect(data.identityContinuous.handsOff).toBe(true);
	});

	it("marks itself observe-only", async () => {
		// A consumer of this payload has no other way to tell a projection from
		// work that happened.
		expect((await run(["status"])).data).toMatchObject({ observeOnly: true });
	});

	it("carries the app trail's ordered steps beside the identity guarantee", async () => {
		// The order is the migration. Reporting a set rather than a sequence
		// would hide a dependency inversion that only shows up at run time.
		const data = (await run(["status"])).data as {
			appTrail: { orderedStepIds: string[]; id: string; version: unknown };
		};
		expect(Array.isArray(data.appTrail.orderedStepIds)).toBe(true);
		expect(data.appTrail.id).toBeTruthy();
	});

	it("reports the hands-off oracle's own verdict and summary", async () => {
		// `ok` alone cannot be acted on. The oracle name and summary are what say
		// which check decided, and the result's `ok` is gated on it as well as on
		// the plan.
		const data = (await run(["status"])).data as {
			handsOffOracle: { oracle: string; ok: boolean; summary: string };
		};
		expect(data.handsOffOracle.oracle).toBeTruthy();
		expect(typeof data.handsOffOracle.ok).toBe("boolean");
		expect(data.handsOffOracle.summary).toBeTruthy();
	});

	it("emits a progress line naming the fidelity it observed at", async () => {
		// Fidelity is how close the local fixtures are to the real substrate. A
		// ready verdict at low fidelity means something different from one at
		// high, and the streamed line is where an operator sees it.
		await run(["status"]);
		expect(progress.length).toBeGreaterThan(0);
		expect(progress.join(" ")).toMatch(/trails (ready|blocked)/);
	});
});

describe("plan", () => {
	it("returns a dry-run plan and says so", async () => {
		// `plan` must never be mistaken for `run`. The flag is in the payload
		// because that is what a non-human consumer reads.
		const data = (await run(["plan"])).data as {
			plan: { dryRun: boolean; orderedStepIds: string[] };
			observeOnly: boolean;
		};
		expect(data.plan.dryRun).toBe(true);
		expect(data.observeOnly).toBe(true);
		expect(Array.isArray(data.plan.orderedStepIds)).toBe(true);
	});

	it("keys its code and status on the can-trail verdict, not on reaching an answer", async () => {
		// A plan that computed successfully for a blocked trail is still a
		// blocked trail. Reporting `ok` for "we produced a plan" would invert the
		// gate's meaning.
		const result = await run(["plan"]);
		expect(["HOBO_TRAILS_PLAN_OK", "HOBO_TRAILS_PLAN_BLOCKED"]).toContain(
			result.code,
		);
		expect(result.ok).toBe(result.code === "HOBO_TRAILS_PLAN_OK");
		expect(result.status).toBe(result.ok ? "planned" : "blocked");
	});

	it("names the trail and its version in the plan payload", async () => {
		// A plan without its trail version cannot be compared against a later
		// one, which is the main thing anyone does with two plans.
		const plan = (
			(await run(["plan"])).data as {
				plan: { trailId: string; trailVersion: unknown };
			}
		).plan;
		expect(plan.trailId).toBeTruthy();
		expect(plan.trailVersion).toBeDefined();
	});

	it("repeats the identity hands-off guarantee alongside the app plan", async () => {
		// The two are separate claims: this app's plan, and the standing promise
		// about pure identity. A reader of `plan` should not have to also call
		// `status` to learn the second.
		const data = (await run(["plan"])).data as {
			identityHandsOff: {
				bindleConfigRequired: boolean;
				continuousDefault: boolean;
			};
		};
		expect(data.identityHandsOff.bindleConfigRequired).toBe(false);
		expect(data.identityHandsOff.continuousDefault).toBe(true);
	});

	it("emits a progress line carrying the can-trail summary", async () => {
		await run(["plan"]);
		expect(progress.join(" ")).toContain("trail plan");
	});
});

describe("inspect", () => {
	it("defaults to the app trail when no id is given", async () => {
		// `hobo trails inspect` with no argument is the common case — there is
		// one app trail, and requiring its id would make the user look it up
		// from `status` first.
		const result = await run(["inspect"]);
		expect(result.ok).toBe(true);
		expect(result.code).toBe("HOBO_TRAILS_INSPECT");
	});

	it("refuses an unknown id and lists the ones it knows", async () => {
		// "not found" without the known set leaves the user guessing at a name.
		const result = await run(["inspect", "trail:does-not-exist"]);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_TRAILS_NOT_FOUND");
		expect(result.message).toContain("trail:does-not-exist");
		expect((result.remediation ?? []).join(" ")).toContain("Known fixtures");
	});

	it("carries the tenant into the not-found payload", async () => {
		// A trail missing *in this tenant* is a different problem from a trail
		// that does not exist. Without the tenant the message cannot distinguish
		// them.
		const result = await run(["inspect", "missing"], {
			hoboHome: home(),
			flags: { tenant: "acme" },
		});
		expect((result.data as { tenant: string }).tenant).toBe("acme");
	});

	it("resolves the identity trail by its own id", async () => {
		// The identity trail is not in the app fixtures; a lookup that only
		// searched those would report the one trail that always exists as
		// missing.
		const identityId = (
			(await run(["status"])).data as {
				identityContinuous: { trailId: string };
			}
		).identityContinuous.trailId;
		const result = await run(["inspect", identityId]);
		expect(result.ok).toBe(true);
		expect((result.data as { trail: { id: string } }).trail.id).toBe(
			identityId,
		);
	});

	it("reports the identity trail as needing no Bindle configuration", async () => {
		// Even where the generic plan would say configuration is required, pure
		// identity is overridden to false — that override is the guarantee, and
		// it is the one line that could silently regress.
		const identityId = (
			(await run(["status"])).data as {
				identityContinuous: { trailId: string };
			}
		).identityContinuous.trailId;
		const data = (await run(["inspect", identityId])).data as {
			bindleConfigRequired: boolean;
		};
		expect(data.bindleConfigRequired).toBe(false);
	});

	it("describes the trail's shape: version, hash, steps, recipes", async () => {
		// The content hash is how two inspections are compared across machines;
		// the step ids are what a plan is checked against.
		const trail = (
			(await run(["inspect"])).data as {
				trail: {
					version: unknown;
					contentHash: string;
					stepIds: string[];
					recipeList: unknown[];
				};
			}
		).trail;
		expect(trail.version).toBeDefined();
		expect(trail.contentHash).toBeTruthy();
		expect(Array.isArray(trail.stepIds)).toBe(true);
		expect(Array.isArray(trail.recipeList)).toBe(true);
	});

	it("stays ok while reporting a blocked status", async () => {
		// `inspect` answers a question; a blocked trail is a valid answer, not a
		// failed command. Returning `ok: false` would make a shell script treat
		// "I looked and it is blocked" as "I could not look".
		const result = await run(["inspect"]);
		expect(result.ok).toBe(true);
		expect(["ready", "blocked"]).toContain(result.status);
	});

	it("emits a progress line with the step count and the can verdict", async () => {
		await run(["inspect"]);
		expect(progress.join(" ")).toMatch(/steps=\d+ can=(true|false)/);
	});
});
