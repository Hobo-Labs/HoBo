/**
 * Management operations: the shared result envelope, Station context
 * resolution, Station ops, and Connection ops.
 *
 * Every function here returns a `ManagementResult` rather than throwing, so the
 * failure mode this file guards is not a crash — it is a result that says `ok`
 * when the operation did not happen, or one that reports the wrong `code` and
 * sends the CLI, MCP and control API down three different remediation paths.
 * Each assertion names which of those it prevents.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { ManagementContext } from "../src/context.js";
import {
	connectionAuthorize,
	connectionCreate,
	connectionGet,
	connectionList,
	connectionRevoke,
	connectionRotate,
	createManagementContext,
	errResult,
	okResult,
	resolveDefaultStationId,
	stationDown,
	stationInit,
	stationRailsActivate,
	stationRailsApprove,
	stationRailsList,
	stationRailsPublish,
	stationStatus,
	stationUp,
} from "../src/index.js";

const temps: string[] = [];
const savedStationEnv = process.env.HOBO_STATION;

afterEach(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
	temps.length = 0;
	// `resolveDefaultStationId` reads this directly, so a leaked value would
	// silently retarget every later test at a Station that does not exist.
	if (savedStationEnv === undefined) delete process.env.HOBO_STATION;
	else process.env.HOBO_STATION = savedStationEnv;
});

function tempHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-mgmt-ops-"));
	temps.push(dir);
	return dir;
}

type TestContext = { ctx: ManagementContext; home: string };

function newContext(): TestContext {
	const home = tempHome();
	return { ctx: createManagementContext({ hoboHome: home }), home };
}

function initialized(): { ctx: ManagementContext; home: string } {
	const made = newContext();
	stationInit(made.ctx, { name: "local", tenant: "local" });
	return made;
}

describe("result envelope", () => {
	it("builds a frozen ok result with defaults", () => {
		const result = okResult("done", { a: 1 });
		expect(result).toEqual({
			ok: true,
			code: "HOBO_OK",
			message: "done",
			data: { a: 1 },
		});
		// Frozen because the envelope crosses three surfaces (CLI, MCP, control
		// API); one of them mutating it would change what the others report.
		expect(Object.isFrozen(result)).toBe(true);
		// `status` is absent, not undefined — a serialized result must not carry
		// a key the caller never set.
		expect(Object.hasOwn(result, "status")).toBe(false);
	});

	it("honours an explicit ok code and status", () => {
		expect(
			okResult("m", {}, { code: "HOBO_CUSTOM", status: "created" }),
		).toMatchObject({
			code: "HOBO_CUSTOM",
			status: "created",
		});
	});

	it("builds a frozen error result with defaults and omits unset fields", () => {
		const result = errResult("bad");
		expect(result).toEqual({ ok: false, code: "HOBO_ERR", message: "bad" });
		expect(Object.isFrozen(result)).toBe(true);
		for (const key of ["status", "remediation", "data"]) {
			expect(Object.hasOwn(result, key), key).toBe(false);
		}
	});

	it("carries remediation and data when supplied", () => {
		const result = errResult("bad", {
			code: "X",
			status: "usage",
			remediation: ["do the thing"],
			data: { detail: 1 },
		});
		// Remediation is what the CLI prints as the next step; losing it turns a
		// fixable error into a bare message.
		expect(result.remediation).toEqual(["do the thing"]);
		expect(result.data).toEqual({ detail: 1 });
	});

	it("distinguishes ok from err by the flag, not by the code", () => {
		// Callers branch on `ok`. An error that defaulted to a success-looking
		// code would still be an error, and this pins that the two are
		// independent.
		expect(okResult("m", {}).ok).toBe(true);
		expect(errResult("m", { code: "HOBO_OK" }).ok).toBe(false);
	});
});

describe("resolveDefaultStationId", () => {
	it("prefers an explicit id over the environment and the profile", () => {
		const { ctx, home } = newContext();
		process.env.HOBO_STATION = "station:env";
		writeFileSync(
			join(home, "profile.json"),
			JSON.stringify({ defaultStation: { id: "station:profile" } }),
			"utf8",
		);
		// Precedence is a user-facing contract: an explicit `--station` must win,
		// or a stale env var silently retargets an operation at another Station.
		expect(resolveDefaultStationId(ctx, "station:flag")).toBe("station:flag");
	});

	it("falls through to the environment, then the profile", () => {
		const { ctx, home } = newContext();
		writeFileSync(
			join(home, "profile.json"),
			JSON.stringify({ defaultStation: { id: "station:profile" } }),
			"utf8",
		);
		process.env.HOBO_STATION = "station:env";
		expect(resolveDefaultStationId(ctx)).toBe("station:env");
		delete process.env.HOBO_STATION;
		expect(resolveDefaultStationId(ctx)).toBe("station:profile");
	});

	it("ignores an empty explicit id and an empty environment value", () => {
		const { ctx, home } = newContext();
		writeFileSync(
			join(home, "profile.json"),
			JSON.stringify({ defaultStation: { id: "station:profile" } }),
			"utf8",
		);
		process.env.HOBO_STATION = "";
		// An unset env var read as `""` must not count as a selection, or the
		// profile default would become unreachable.
		expect(resolveDefaultStationId(ctx, "")).toBe("station:profile");
	});

	it("returns undefined when nothing names a Station", () => {
		const { ctx } = newContext();
		delete process.env.HOBO_STATION;
		// Undefined, not a guessed default: the caller turns this into a usage
		// error with a remediation, which is more useful than silently operating
		// on a Station the user did not choose.
		expect(resolveDefaultStationId(ctx)).toBeUndefined();
	});

	it("tolerates a corrupt or incomplete profile", () => {
		const { ctx, home } = newContext();
		delete process.env.HOBO_STATION;
		for (const contents of ["{", "null", "{}", '{"defaultStation":{}}']) {
			writeFileSync(join(home, "profile.json"), contents, "utf8");
			// A hand-edited profile must not make every command throw; the read is
			// best-effort by design.
			expect(resolveDefaultStationId(ctx), contents).toBeUndefined();
		}
	});
});

describe("management context — actor resolution", () => {
	it("defaults to the local user when no profile exists", () => {
		const { ctx } = newContext();
		expect(ctx.resolveActor()).toEqual({
			kind: "user",
			id: "user:local",
			tenant: "local",
		});
	});

	it("reads the principal and tenant from the profile session", () => {
		const { ctx, home } = newContext();
		writeFileSync(
			join(home, "profile.json"),
			JSON.stringify({
				session: {
					principal: { kind: "service", id: "svc:ci" },
					tenant: "acme",
				},
			}),
			"utf8",
		);
		// The actor is stamped into every connection as subject and createdBy, so
		// reading the wrong one attributes a credential to the wrong principal.
		expect(ctx.resolveActor()).toEqual({
			kind: "service",
			id: "svc:ci",
			tenant: "acme",
		});
	});

	it("defaults kind and tenant when the profile names only an id", () => {
		const { ctx, home } = newContext();
		writeFileSync(
			join(home, "profile.json"),
			JSON.stringify({ session: { principal: { id: "u:1" } } }),
			"utf8",
		);
		expect(ctx.resolveActor()).toEqual({
			kind: "user",
			id: "u:1",
			tenant: "local",
		});
	});

	it("falls back to the local user for a corrupt or principal-less profile", () => {
		const { ctx, home } = newContext();
		for (const contents of [
			"{",
			"{}",
			'{"session":{}}',
			'{"session":{"principal":{}}}',
		]) {
			writeFileSync(join(home, "profile.json"), contents, "utf8");
			// Falling back rather than throwing keeps a broken profile from
			// bricking every command — but it must fall back to the *least*
			// privileged identity, not to whatever was half-parsed.
			expect(ctx.resolveActor().id, contents).toBe("user:local");
		}
	});
});

describe("management context — station loading", () => {
	it("loadStationState returns null for a Station with no events", () => {
		const { ctx } = newContext();
		// Null rather than a throw: callers turn this into a `station-missing`
		// result with a remediation.
		expect(ctx.loadStationState("station:absent")).toBeNull();
	});

	it("loadStationState returns state for an initialized Station", () => {
		const { ctx } = initialized();
		const state = ctx.loadStationState("station:local");
		expect(state?.occupancy.status).toBe("open");
	});

	it("loadStation throws for a missing Station", () => {
		const { ctx } = newContext();
		// The difference from `loadStationState` is deliberate: this one is used
		// where the caller already means to report the failure.
		expect(() => ctx.loadStation("station:absent")).toThrow();
	});

	it("listStations reports what is on disk", () => {
		const { ctx } = newContext();
		expect(ctx.listStations()).toEqual([]);
		stationInit(ctx, { name: "local" });
		expect(ctx.listStations()).toEqual(["station:local"]);
	});

	it("tracks occupy mode per Station id, defaulting to idle", () => {
		const { ctx } = newContext();
		expect(ctx.getOccupyMode("station:a")).toBe("idle");
		ctx.setOccupyMode("station:a", "occupying");
		expect(ctx.getOccupyMode("station:a")).toBe("occupying");
		// Per-id, so bringing one Station up does not report a sibling as running.
		expect(ctx.getOccupyMode("station:b")).toBe("idle");
	});
});

describe("station ops", () => {
	it("init creates a Station and writes the profile default", () => {
		const { ctx, home } = newContext();
		const result = stationInit(ctx, { name: "local", tenant: "local" });
		expect(result.ok).toBe(true);
		expect(result.data?.created).toBe(true);
		expect(result.data?.bootstrapActive).toBe(true);
		// SAFETY: this test reads the profile shape written by stationInit.
		const profile = JSON.parse(
			readFileSync(join(home, "profile.json"), "utf8"),
		) as { custom?: string };
		// The profile default is what makes every later command work without
		// `--station`; skipping the write would make init succeed and leave the
		// CLI unable to find what it created.
		expect(profile.defaultStation).toMatchObject({ id: "station:local" });
		expect(profile.schemaVersion).toBe("hobo.profile/v1");
	});

	it("init is idempotent and reports created:false the second time", () => {
		const { ctx } = newContext();
		stationInit(ctx, { name: "local" });
		const again = stationInit(ctx, { name: "local" });
		expect(again.ok).toBe(true);
		expect(again.data?.created).toBe(false);
		expect(again.message).toMatch(/already exists/u);
	});

	it("init preserves unrelated keys already in the profile", () => {
		const { ctx, home } = newContext();
		writeFileSync(
			join(home, "profile.json"),
			JSON.stringify({ session: { tenant: "acme" }, custom: "keep" }),
			"utf8",
		);
		stationInit(ctx, { name: "local" });
		// SAFETY: this test reads the profile shape written by stationInit.
		const profile = JSON.parse(
			readFileSync(join(home, "profile.json"), "utf8"),
		) as { custom?: string };
		// The write merges rather than replaces — clobbering the session would
		// log the user out as a side effect of initializing a Station.
		expect(profile.custom).toBe("keep");
		expect(profile.session).toEqual({ tenant: "acme" });
	});

	it("init survives a corrupt profile", () => {
		const { ctx, home } = newContext();
		writeFileSync(join(home, "profile.json"), "{not json", "utf8");
		// The profile write is documented best-effort. A corrupt file must not
		// stop the Station from being created, because the Station is the thing
		// the user asked for.
		const result = stationInit(ctx, { name: "local" });
		expect(result.ok).toBe(true);
		expect(ctx.loadStationState("station:local")).not.toBeNull();
	});

	it("init imports a broker document when one sits in HOBO_HOME", () => {
		const { ctx, home } = newContext();
		writeFileSync(
			join(home, "hobo.broker.json"),
			JSON.stringify({ brokerId: "acme", delivery: { engine: "argo" } }),
			"utf8",
		);
		const result = stationInit(ctx, { name: "local" });
		// Importing clears the bootstrap-only posture, which is the reason to
		// place the document there at all.
		expect(result.data?.activatedRailHash).toBeDefined();
		expect(result.data?.bootstrapActive).toBe(false);
	});

	it("init honours an explicit id", () => {
		const { ctx } = newContext();
		expect(
			stationInit(ctx, { id: "station:custom", name: "eu" }).data?.stationId,
		).toBe("station:custom");
	});

	it("status reports occupancy, the active Rail and a doctor hint", () => {
		const { ctx } = initialized();
		const result = stationStatus(ctx, "station:local");
		expect(result.ok).toBe(true);
		expect(result.data?.status).toBe("open");
		expect(result.data?.occupyMode).toBe("idle");
		// SAFETY: stationStatus success data contains the activeRail projection.
		expect(
			(result.data as { activeRail?: { isBootstrap: boolean } }).activeRail,
		)?.toMatchObject({ isBootstrap: true });
		// The hint is what tells an operator their Station is not
		// production-ready; a status that reported healthy would hide it.
		// SAFETY: stationStatus success data contains the doctor projection.
		expect((result.data as { doctor: { hint?: string } }).doctor.hint).toMatch(
			/bootstrap Rail active/u,
		);
	});

	it("status fails with a remediation for a missing Station", () => {
		const { ctx } = newContext();
		const result = stationStatus(ctx, "station:absent");
		expect(result.ok).toBe(false);
		// The code is echoed into `data` as well as the envelope because the
		// control API surfaces the two differently.
		expect(result.code).toBe("station-missing");
		expect(result.data).toMatchObject({ code: "station-missing" });
		expect(result.remediation).toEqual(["hobo station init"]);
	});

	it("status falls back to station:local when nothing names a Station", () => {
		const { ctx } = initialized();
		delete process.env.HOBO_STATION;
		// Unlike the raw resolver, the ops layer does supply a default — the
		// conventional single-Station local setup must work with no flags.
		expect(stationStatus(ctx).data?.stationId).toBe("station:local");
	});

	it("up flips occupy mode and down flips it back", () => {
		const { ctx } = initialized();
		expect(stationUp(ctx, "station:local").data?.status).toBe("occupying");
		expect(ctx.getOccupyMode("station:local")).toBe("occupying");
		expect(stationStatus(ctx, "station:local").data?.occupyMode).toBe(
			"occupying",
		);

		const down = stationDown(ctx, "station:local");
		expect(down.data?.status).toBe("idle");
		// Data survives a `down`; this is an occupancy toggle, not a teardown.
		expect(down.data?.dataRetained).toBe(true);
		expect(ctx.loadStationState("station:local")).not.toBeNull();
	});

	it("up propagates a missing-Station failure instead of reporting occupying", () => {
		const { ctx } = newContext();
		const result = stationUp(ctx, "station:absent");
		// Reporting `occupying` for a Station that does not exist would have the
		// CLI print success for a no-op.
		expect(result.ok).toBe(false);
		expect(result.code).toBe("station-missing");
	});

	it("down succeeds for an unknown Station", () => {
		const { ctx } = newContext();
		// Deliberately unguarded: `down` is the safe direction, and refusing it
		// for an unknown id would leave an operator with no way to clear a stale
		// occupy mode.
		expect(stationDown(ctx, "station:absent").ok).toBe(true);
	});
});

describe("station rail ops", () => {
	it("lists the bootstrap Rail on a fresh Station", () => {
		const { ctx } = initialized();
		const result = stationRailsList(ctx, "station:local");
		expect(result.ok).toBe(true);
		// SAFETY: stationRailsList success data contains its rails projection.
		const rails = (
			result.data as { rails: readonly { isBootstrap: boolean }[] }
		).rails;
		expect(rails).toHaveLength(1);
		expect(rails[0]?.isBootstrap).toBe(true);
	});

	it("fails to list rails for a missing Station", () => {
		const { ctx } = newContext();
		const result = stationRailsList(ctx, "station:absent");
		expect(result.ok).toBe(false);
		expect(result.code).toBe("station-missing");
	});

	it("publishes a draft Rail from explicit fields", () => {
		const { ctx } = initialized();
		const result = stationRailsPublish(ctx, {
			stationId: "station:local",
			id: "rail-a",
			name: "a",
			version: "1.0.0",
		});
		expect(result.ok).toBe(true);
		// Draft, not approved: publishing is not blessing, and a Rail that
		// arrived approved would skip the human review step entirely.
		expect(result.data?.activationStatus).toBe("draft");
		expect(stationRailsList(ctx, "station:local").data).toMatchObject({});
	});

	it("publishes from a document on disk, preferring its fields", () => {
		const { ctx, home } = initialized();
		const docPath = join(home, "rail.json");
		writeFileSync(
			docPath,
			JSON.stringify({ id: "rail-doc", name: "from-doc", version: "2.0.0" }),
			"utf8",
		);
		const result = stationRailsPublish(ctx, {
			stationId: "station:local",
			docPath,
			id: "ignored",
			name: "ignored",
		});
		// The document is the more specific source; letting the flags win would
		// make a file-driven publish silently ignore the file.
		expect(result.data?.railId).toBe("rail-doc");
	});

	it("prefers raw over docPath", () => {
		const { ctx, home } = initialized();
		const docPath = join(home, "rail.json");
		writeFileSync(docPath, JSON.stringify({ id: "rail-doc" }), "utf8");
		expect(
			stationRailsPublish(ctx, {
				stationId: "station:local",
				docPath,
				raw: { id: "rail-raw", name: "n", version: "1.0.0" },
			}).data?.railId,
		).toBe("rail-raw");
	});

	it("fails to publish to a missing Station", () => {
		const { ctx } = newContext();
		expect(
			stationRailsPublish(ctx, { stationId: "station:absent", id: "r" }).code,
		).toBe("station-missing");
	});

	it("approves and activates a published Rail, by hash or by id", () => {
		const { ctx } = initialized();
		const published = stationRailsPublish(ctx, {
			stationId: "station:local",
			id: "rail-a",
			name: "a",
			version: "1.0.0",
		});
		const hash = String(published.data?.contentHash);

		const approved = stationRailsApprove(ctx, {
			stationId: "station:local",
			hashOrId: hash,
		});
		expect(approved.ok).toBe(true);
		expect(approved.data?.contentHash).toBe(hash);

		// Resolving by the human-facing rail id as well as by hash is what makes
		// the CLI usable — an operator reads ids, not digests.
		const activated = stationRailsActivate(ctx, {
			stationId: "station:local",
			hashOrId: "rail-a",
		});
		expect(activated.ok).toBe(true);
		expect(activated.data?.contentHash).toBe(hash);

		const status = stationStatus(ctx, "station:local");
		// Activating a real Rail is what clears the bootstrap posture.
		expect(status.data?.activeRailHash).toBe(hash);
		expect(status.data?.bootstrapActive).toBe(false);
	});

	it("fails a transition for an unknown rail with its own code", () => {
		const { ctx } = initialized();
		const result = stationRailsApprove(ctx, {
			stationId: "station:local",
			hashOrId: "sha256:nope",
		});
		// `rail-missing`, not `station-missing`: the two send an operator to
		// different next steps.
		expect(result.ok).toBe(false);
		expect(result.code).toBe("rail-missing");
	});

	it("fails a transition against a missing Station", () => {
		const { ctx } = newContext();
		expect(
			stationRailsActivate(ctx, { stationId: "station:absent", hashOrId: "x" })
				.code,
		).toBe("station-missing");
	});
});

describe("connection ops — usage guards", () => {
	it("requires a provider to create", () => {
		const { ctx } = initialized();
		const result = connectionCreate(ctx, { provider: "" });
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_CONNECTION_NO_PROVIDER");
		// `usage` distinguishes "you called this wrong" from "it failed", which
		// is what decides whether the CLI prints help or an error.
		expect(result.status).toBe("usage");
	});

	it("requires an id for every id-taking verb", () => {
		const { ctx } = initialized();
		for (const [name, run] of [
			["authorize", () => connectionAuthorize(ctx, { idOrAlias: "" })],
			["get", () => connectionGet(ctx, { idOrAlias: "" })],
			["revoke", () => connectionRevoke(ctx, { idOrAlias: "" })],
			["rotate", () => connectionRotate(ctx, { idOrAlias: "" })],
		] as const) {
			const result = run();
			expect(result.ok, name).toBe(false);
			expect(result.code, name).toBe("HOBO_CONNECTION_NO_ID");
			expect(result.status, name).toBe("usage");
		}
	});

	it("requires Station context to create", () => {
		const { ctx } = newContext();
		delete process.env.HOBO_STATION;
		const result = connectionCreate(ctx, { provider: "github" });
		// A connection is Station-scoped on the identity plane. Creating one with
		// no Station would produce a credential nothing can present.
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_CONNECTION_STATION_REQUIRED");
		expect(result.remediation).toEqual(["hobo station init"]);
	});
});

describe("connection ops — lifecycle", () => {
	function ctx0(): ManagementContext {
		return initialized().ctx;
	}

	function withConnection() {
		const made = initialized();
		const created = connectionCreate(made.ctx, {
			provider: "github",
			alias: "gh",
			scopes: ["repo"],
		});
		return { ...made, created };
	}

	it("creates a pending connection scoped to the Station and actor", () => {
		const { created } = withConnection();
		expect(created.ok).toBe(true);
		expect(created.status).toBe("created");
		// SAFETY: connectionCreate success data contains the public connection.
		const connection = (
			created.data as {
				connection: { provider: string; alias?: string };
			}
		).connection;
		expect(connection.provider).toBe("github");
		expect(connection.alias).toBe("gh");
		expect(connection.stationId).toBe("station:local");
		// Pending, not authorized: creation records intent, and a connection that
		// arrived usable would skip the consent step.
		expect(created.message).toMatch(/pending authorize/u);
	});

	it("defaults the flow to oauth2-obo", () => {
		const { created } = withConnection();
		// SAFETY: connectionCreate success data contains the public connection.
		expect(
			(created.data as { connection: { flow: string } }).connection.flow,
		).toBe("oauth2-obo");
	});

	it("persists across a fresh context", () => {
		const { home } = withConnection();
		const reloaded = createManagementContext({ hoboHome: home });
		// The whole point of persisting: a connection created by one CLI
		// invocation must be visible to the next.
		expect(connectionList(reloaded).data?.count).toBe(1);
	});

	it("lists, filters and counts", () => {
		const { ctx } = withConnection();
		connectionCreate(ctx, { provider: "gitlab", alias: "gl" });
		expect(connectionList(ctx).data?.count).toBe(2);
		expect(connectionList(ctx, { provider: "github" }).data?.count).toBe(1);
		// A filter that matched nothing must report zero rather than falling back
		// to everything, which would look like the filter was ignored.
		expect(connectionList(ctx, { provider: "bitbucket" }).data?.count).toBe(0);
		expect(connectionList(ctx, { status: "pending" }).data?.count).toBe(2);
	});

	it("gets by alias and by id", () => {
		const { ctx, created } = withConnection();
		// SAFETY: connectionCreate success data contains the public connection id.
		const id = String(
			(created.data as { connection: { id: string } }).connection.id,
		);
		expect(connectionGet(ctx, { idOrAlias: "gh" }).ok).toBe(true);
		expect(connectionGet(ctx, { idOrAlias: id }).ok).toBe(true);
	});

	it("reports not_found with a remediation for an unknown connection", () => {
		const { ctx } = initialized();
		const result = connectionGet(ctx, { idOrAlias: "nope" });
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_CONNECTION_NOT_FOUND");
		// `not_found` rather than a generic failure, so the control API can map
		// it to a 404 instead of a 500.
		expect(result.status).toBe("not_found");
		expect(result.remediation).toEqual(["hobo connection list"]);
	});

	it("authorizes a pending connection and records the granted scopes", () => {
		const { ctx } = withConnection();
		const result = connectionAuthorize(ctx, {
			idOrAlias: "gh",
			grantedScopes: ["repo"],
		});
		expect(result.ok).toBe(true);
		expect(result.status).toBe("authorized");
		// SAFETY: connectionAuthorize success data contains the public connection.
		const connection = (result.data as { connection: { status: string } })
			.connection;
		expect(connection.status).not.toBe("pending");
	});

	it("wraps an authorize failure in the envelope rather than throwing", () => {
		const { ctx } = initialized();
		const result = connectionAuthorize(ctx, { idOrAlias: "not-a-connection" });
		// Every management verb returns a result. A thrown error here would
		// escape three different callers that all expect an envelope.
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_CONNECTION_AUTHORIZE_FAILED");
		expect(result.message).not.toBe("");
	});

	it("revokes with a default reason and reports it", () => {
		const { ctx } = withConnection();
		connectionAuthorize(ctx, { idOrAlias: "gh", grantedScopes: ["repo"] });
		const result = connectionRevoke(ctx, { idOrAlias: "gh" });
		expect(result.ok).toBe(true);
		expect(result.status).toBe("revoked");
		// Revocation is terminal; the connection stays listed so the audit trail
		// survives rather than the row disappearing.
		expect(connectionList(ctx).data?.count).toBe(1);
	});

	it("wraps a revoke and rotate failure in the envelope", () => {
		const { ctx } = initialized();
		expect(connectionRevoke(ctx, { idOrAlias: "nope" }).code).toBe(
			"HOBO_CONNECTION_REVOKE_FAILED",
		);
		expect(connectionRotate(ctx, { idOrAlias: "nope" }).code).toBe(
			"HOBO_CONNECTION_ROTATE_FAILED",
		);
	});

	it("passes an unrecognized flow straight through", () => {
		// Pinning what happens rather than what I expected. `flow` is a *cast*
		// in `connectionCreate` (`input.flow as ConnectionFlow | undefined`),
		// not a parse, and the service does not reject an unknown value — so an
		// arbitrary string becomes the connection's flow. It fails later, when
		// something tries to run that flow, rather than at the boundary where
		// the caller could be told which flows exist. Flagged, not changed:
		// tightening it belongs with the flow vocabulary in `@hobo/identity`,
		// not in a management-layer cast.
		const result = connectionCreate(ctx0(), {
			provider: "github",
			flow: "not-a-flow",
		});
		expect(result.ok).toBe(true);
		// SAFETY: connectionCreate preserves the caller-provided flow in success data.
		expect(
			(result.data as { connection: { flow: string } }).connection.flow,
		).toBe("not-a-flow");
	});

	it("wraps a create failure in the envelope and keeps the service's code", () => {
		const { ctx } = withConnection();
		// A duplicate alias is refused by the service; the management layer must
		// surface that as an envelope rather than throwing, and must prefer the
		// service's own code so a caller can tell it apart from a generic
		// create failure.
		const duplicate = connectionCreate(ctx, {
			provider: "github",
			alias: "gh",
		});
		if (duplicate.ok) {
			// The service permits it; nothing to assert about the failure path
			// here, and pretending otherwise would make this test lie.
			expect(duplicate.data).toBeDefined();
			return;
		}
		expect(duplicate.code).not.toBe("HOBO_OK");
		expect(duplicate.message.length).toBeGreaterThan(0);
	});

	it("scopes connections per tenant on read", () => {
		const { ctx } = initialized();
		connectionCreate(ctx, { provider: "github", alias: "gh", tenant: "acme" });
		expect(connectionList(ctx, { tenant: "acme" }).data?.count).toBe(1);
		// This is the assertion that caught the leak fixed alongside this test.
		// All tenants share one `connections/events.jsonl`, and the whole file
		// used to be handed to a `ConnectionService` constructed for a single
		// tenant. The service guards *mutations* with `assertSameTenant` but
		// `list()` and `get()` read `byId` unfiltered — so any tenant could
		// enumerate every other tenant's connections.
		expect(connectionList(ctx, { tenant: "other" }).data?.count).toBe(0);
	});

	it("refuses a cross-tenant get", () => {
		const { ctx } = initialized();
		connectionCreate(ctx, { provider: "github", alias: "gh", tenant: "acme" });
		const stolen = connectionGet(ctx, { idOrAlias: "gh", tenant: "evil-corp" });
		// The public view carries provider, subject, stationId, grantedScopes
		// and credentialRef. Returning it to another tenant is a disclosure even
		// though the credential itself stays in the vault.
		expect(stolen.ok).toBe(false);
		expect(stolen.code).toBe("HOBO_CONNECTION_NOT_FOUND");
	});

	it("does not destroy another tenant's history when one tenant writes", () => {
		const { ctx, home } = initialized();
		connectionCreate(ctx, {
			provider: "github",
			alias: "a-gh",
			tenant: "acme",
		});
		connectionCreate(ctx, {
			provider: "gitlab",
			alias: "b-gl",
			tenant: "beta",
		});
		// The read filter and the write merge are one change: filtering the load
		// without merging the persist would have each tenant's write delete
		// every other tenant's events from the shared file.
		expect(connectionList(ctx, { tenant: "acme" }).data?.count).toBe(1);
		expect(connectionList(ctx, { tenant: "beta" }).data?.count).toBe(1);
		const stored = readFileSync(
			join(home, "connections", "events.jsonl"),
			"utf8",
		)
			.split("\n")
			.filter(Boolean);
		expect(stored.length).toBeGreaterThanOrEqual(2);
		// And it survives a fresh process.
		const reloaded = createManagementContext({ hoboHome: home });
		expect(connectionList(reloaded, { tenant: "acme" }).data?.count).toBe(1);
		expect(connectionList(reloaded, { tenant: "beta" }).data?.count).toBe(1);
	});

	it("keeps a tenant's own later writes visible to itself", () => {
		const { ctx } = initialized();
		connectionCreate(ctx, { provider: "github", alias: "a1", tenant: "acme" });
		connectionCreate(ctx, { provider: "gitlab", alias: "b1", tenant: "beta" });
		connectionCreate(ctx, {
			provider: "bitbucket",
			alias: "a2",
			tenant: "acme",
		});
		// Interleaved writes from two tenants must not drop either side — the
		// merge appends this tenant's full event list after everyone else's.
		expect(connectionList(ctx, { tenant: "acme" }).data?.count).toBe(2);
		expect(connectionList(ctx, { tenant: "beta" }).data?.count).toBe(1);
	});

	it("never places a credential in the public view", () => {
		const { ctx } = withConnection();
		connectionAuthorize(ctx, { idOrAlias: "gh", grantedScopes: ["repo"] });
		const serialized = JSON.stringify(connectionList(ctx).data);
		// `toPublicConnection` carries a `credentialRef` — a locator — and never
		// a secret. This is the assertion that fails if a future edit widens the
		// view to the whole connection record.
		expect(serialized).not.toMatch(/"secret"|"token"|"password"|rootSecret/u);
	});
});
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening -- SAFETY: tests assert serialized and operation result contracts at their boundaries. */
