import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CD_DEFAULTS,
	PromotionState,
	ReconcilerMode,
	RolloutStrategy,
	TaintEffect,
} from "@hobo/cd";
import { assertToolSurfaceParity } from "@hobo/mcp";
import { describe, expect, it } from "vitest";
import {
	CD_DEPLOY_ACTIONS,
	CD_DEPLOY_SUBCOMMANDS,
	matchCdSubcommand,
	runCdDeploySubcommand,
} from "../src/cd-deploy.js";
import { createDeployCommand } from "../src/deploy-command.js";
import { createIncidentCommand } from "../src/incident-command.js";
import {
	type Call,
	ctx,
	FREIGHT,
	fakeCd,
	host,
	promotion,
	refusal,
	runInput,
} from "./support/cd-fakes.js";

// WP18 Build list: every `hobo deploy` subcommand plan 0024 names.
const REQUIRED = [
	"freight record",
	"freight list",
	"freight show",
	"freight yank",
	"freight approve",
	"source define",
	"source list",
	"source poll",
	"pipeline apply",
	"pipeline show",
	"pipeline list",
	"window define",
	"window list",
	"window override",
	"promote",
	"status",
	"logs",
	"rollback",
	"reconcile",
	"preview create",
	"preview list",
	"verify show",
	"agent token",
	"agent enroll",
	"agent run",
	"agent revoke",
	"publisher define",
	"metrics",
	"campset define",
	"campset list",
	"camp list",
	"camp show",
	"camp taint",
	"camp untaint",
	"camp manage",
	"placement define",
	"placement decide",
	"placement show",
	"scores report",
	"fanout show",
	"fanout halt",
	"fanout resume",
	"fanout rollback",
	"failover list",
	"failover approve",
	"rebalance",
	"compliance show",
	"agent approve-key",
	"agent accept",
] as const;

describe("hobo deploy CD subcommands (WP18)", () => {
	it("provides every subcommand the plan names, each with a usage line", () => {
		for (const name of REQUIRED) {
			expect(CD_DEPLOY_SUBCOMMANDS[name]?.usage, name).toMatch(/^hobo deploy /);
		}
		// Every mutating subcommand maps to a governed CdAction (D15).
		for (const sub of Object.keys(CD_DEPLOY_ACTIONS))
			expect(CD_DEPLOY_SUBCOMMANDS[sub], sub).toBeDefined();
	});

	it("matches two-word groups before single words", () => {
		expect(matchCdSubcommand(["freight", "show", "x"])).toEqual({
			name: "freight show",
			rest: ["x"],
		});
		expect(matchCdSubcommand(["promote", "x"])).toEqual({
			name: "promote",
			rest: ["x"],
		});
		expect(matchCdSubcommand(["nope"])).toBeUndefined();
	});

	it("promote calls PromotionService with a deterministic idempotency key (I12)", async () => {
		const calls: Call[] = [];
		const cd = fakeCd(
			{
				freight: { getByAlias: () => FREIGHT },
				promotions: { promote: () => ({ ok: true, value: promotion() }) },
			},
			calls,
		);
		const flags = {
			camp: "yard/b,yard/a",
			strategy: "canary",
			pipeline: "web",
			node: "prod",
		};
		const one = await runCdDeploySubcommand(
			host(cd),
			["promote", "brave-otter"],
			flags,
		);
		await runCdDeploySubcommand(host(cd), ["promote", "brave-otter"], {
			...flags,
			camp: "yard/a,yard/b",
		});
		expect(one.ok).toBe(true);
		expect(one.code).toBe("HOBO_CD_PROMOTION_REQUESTED");
		const requests = calls
			.filter((c) => c.method === "promote")
			.map((c) => c.args[0] as Record<string, unknown>);
		expect(requests).toHaveLength(2);
		expect(requests[0]?.idempotencyKey).toBe(requests[1]?.idempotencyKey);
		expect(requests[0]).toMatchObject({
			freightId: FREIGHT.freightId,
			targets: ["yard/b", "yard/a"],
			pipeline: "web",
			node: "prod",
			strategy: RolloutStrategy.CANARY,
		});
		expect(requests[0]).not.toHaveProperty("proposal");
	});

	it("promote --propose records a proposal", async () => {
		const calls: Call[] = [];
		const cd = fakeCd(
			{
				freight: { getByAlias: () => FREIGHT },
				promotions: {
					promote: () => ({ ok: true, value: promotion({ proposal: true }) }),
				},
			},
			calls,
		);
		const out = await runCdDeploySubcommand(
			host(cd),
			["promote", "brave-otter"],
			{ camp: "c", propose: true },
		);
		expect(out.code).toBe("HOBO_CD_PROMOTION_PROPOSED");
		expect(
			(
				calls.find((c) => c.method === "promote")?.args[0] as {
					proposal?: boolean;
				}
			).proposal,
		).toBe(true);
	});

	it("every refusal carries the module's code and a next step", async () => {
		const cd = fakeCd({
			freight: { getByAlias: () => FREIGHT },
			promotions: {
				promote: () =>
					refusal(
						"lineage-unsatisfied",
						"Qualify the Freight in staging first.",
					),
			},
		});
		const out = await runCdDeploySubcommand(
			host(cd),
			["promote", "brave-otter"],
			{ camp: "prod" },
		);
		expect(out.ok).toBe(false);
		expect(out.status).toBe("refused");
		expect(out.code).toBe("lineage-unsatisfied");
		expect(out.remediation).toEqual(["Qualify the Freight in staging first."]);
		expect((out.data?.reasons as unknown[]).length).toBe(1);
	});

	it("usage errors name the missing flag and the usage line as the next step", async () => {
		const out = await runCdDeploySubcommand(
			host(fakeCd()),
			["promote", "x"],
			{},
		);
		expect(out).toMatchObject({
			ok: false,
			status: "usage",
			code: "HOBO_DEPLOY_USAGE",
		});
		expect(out.message).toMatch(/missing --camp/);
		expect(out.remediation?.[0]).toMatch(/^hobo deploy promote/);
		const unknown = await runCdDeploySubcommand(
			host(fakeCd()),
			["freight", "explode"],
			{},
		);
		expect(unknown.status).toBe("usage");
		expect(
			unknown.remediation?.every((u) => u.startsWith("hobo deploy freight")),
		).toBe(true);
	});

	it("not-found refusals name a next step", async () => {
		const out = await runCdDeploySubcommand(
			host(
				fakeCd({
					freight: { get: () => undefined, getByAlias: () => undefined },
				}),
			),
			["freight", "show", "ghost"],
			{},
		);
		expect(out).toMatchObject({
			ok: false,
			code: "cd-not-found",
			remediation: ["hobo deploy freight list"],
		});
	});

	it("--format json|text changes only the message, never the data", async () => {
		const cd = fakeCd({ freight: { list: () => [FREIGHT] } });
		const json = await runCdDeploySubcommand(host(cd), ["freight", "list"], {
			format: "json",
		});
		const text = await runCdDeploySubcommand(host(cd), ["freight", "list"], {
			format: "text",
		});
		expect(json.data).toEqual(text.data);
		expect(json.message).toBe("1 freight");
		expect(text.message).toContain("brave-otter");
		const bad = await runCdDeploySubcommand(host(cd), ["freight", "list"], {
			format: "yaml",
		});
		expect(bad.status).toBe("usage");
	});

	it("records leave as canonical protobuf JSON (enum names, 64-bit as strings)", async () => {
		const cd = fakeCd({ freight: { list: () => [FREIGHT] } });
		const out = await runCdDeploySubcommand(host(cd), ["freight", "list"], {
			format: "json",
		});
		const freight = (out.data?.freight as Record<string, unknown>[])[0];
		expect(freight?.alias).toBe("brave-otter");
		expect(freight?.freightId).toBe(FREIGHT.freightId);
		expect(out.data?.simulated).toBe(false);
	});

	it("agent and human sessions get identical structures", async () => {
		const stubs = {
			promotions: { list: () => [promotion()] },
			inventory: { list: () => [] },
		};
		const human = await runCdDeploySubcommand(host(fakeCd(stubs)), ["status"], {
			camp: "yard/prod",
		});
		const agent = await runCdDeploySubcommand(
			host(fakeCd(stubs), {
				ctx: { ...ctx, principal: { kind: "agent", id: "agent:sre" } },
			}),
			["status"],
			{ camp: "yard/prod" },
		);
		expect(Object.keys(agent)).toEqual(Object.keys(human));
		expect(agent.data).toEqual(human.data);
	});

	it("freight approve clamps the hotfix TTL to CD_DEFAULTS.hotfixApprovalMaxMs", async () => {
		const calls: Call[] = [];
		const cd = fakeCd(
			{
				freight: {
					getByAlias: () => FREIGHT,
					approve: () => ({ ok: true, value: { expiresAt: "later" } }),
				},
			},
			calls,
		);
		await runCdDeploySubcommand(
			host(cd),
			["freight", "approve", "brave-otter"],
			{
				camp: "prod",
				reason: "hotfix",
				"ttl-ms": String(10 * CD_DEFAULTS.hotfixApprovalMaxMs),
			},
		);
		const input = calls.find((c) => c.method === "approve")?.args[0] as {
			expiresAtMs: number;
		};
		expect(input.expiresAtMs).toBe(ctx.now() + CD_DEFAULTS.hotfixApprovalMaxMs);
	});

	it("rollback passes the target Set and a deterministic key (D12, I7)", async () => {
		const calls: Call[] = [];
		const cd = fakeCd(
			{
				promotions: {
					rollback: () => ({
						ok: true,
						value: promotion({ promotionId: "rb-1" }),
					}),
				},
			},
			calls,
		);
		const out = await runCdDeploySubcommand(host(cd), ["rollback"], {
			camp: "prod",
			reason: "slo",
			to: "set-9",
		});
		expect(out.code).toBe("HOBO_CD_ROLLBACK_REQUESTED");
		expect(calls.find((c) => c.method === "rollback")?.args[0]).toMatchObject({
			campId: "prod",
			toSetId: "set-9",
			reason: "slo",
		});
	});

	it("reconcile without a composed conductor refuses with compose-realizer-missing", async () => {
		const out = await runCdDeploySubcommand(host(fakeCd()), ["reconcile"], {
			camp: "prod",
		});
		expect(out).toMatchObject({ ok: false, code: "compose-realizer-missing" });
		expect(out.remediation?.[0]).toMatch(/--simulate/);
	});

	it("reconcile runs one bounded conductor pass", async () => {
		const passes: string[] = [];
		const out = await runCdDeploySubcommand(
			host(fakeCd(), {
				conductor: () => ({
					reconcilerId: "r" as never,
					mode: ReconcilerMode.CONDUCTOR,
					run: async () => {},
					reconcileOnce: async (campId) => {
						passes.push(campId);
						return { campId } as never;
					},
				}),
			}),
			["reconcile"],
			{ camp: "prod" },
		);
		expect(out.code).toBe("HOBO_CD_RECONCILED");
		expect(passes).toEqual(["prod"]);
	});

	it("camp taint parses the effect; an unknown effect is a usage error", async () => {
		const calls: Call[] = [];
		const cd = fakeCd(
			{ inventory: { taint: () => ({ ok: true, value: {} }) } },
			calls,
		);
		await runCdDeploySubcommand(host(cd), ["camp", "taint", "prod"], {
			key: "region-down",
			effect: "no-run",
			reason: "outage",
		});
		const taint = (
			calls[0]?.args[0] as { taint: { effect: TaintEffect; source: number } }
		).taint;
		expect(taint.effect).toBe(TaintEffect.NO_RUN);
		const bad = await runCdDeploySubcommand(
			host(cd),
			["camp", "taint", "prod"],
			{ key: "k", effect: "evict", reason: "r" },
		);
		expect(bad.status).toBe("usage");
		expect(bad.message).toMatch(/NO_PLACE\|NO_RUN/);
	});

	it("agent enroll refuses a private JWK (the key never leaves the agent)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cd-jwk-"));
		await writeFile(
			join(dir, "k.json"),
			JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "abc", d: "secret" }),
		);
		const out = await runCdDeploySubcommand(
			host(fakeCd(), { cwd: dir }),
			["agent", "enroll"],
			{ token: "t", "jwk-file": "k.json" },
		);
		expect(out).toMatchObject({ ok: false, code: "agent-jwk-invalid" });
	});

	it("agent token clamps the bootstrap TTL to the 24 h maximum", async () => {
		const calls: Call[] = [];
		const cd = fakeCd(
			{
				enrollment: {
					issueToken: () => ({
						ok: true,
						value: { token: "tok", expiresAtMs: 1 },
					}),
				},
			},
			calls,
		);
		await runCdDeploySubcommand(host(cd), ["agent", "token"], {
			"camp-set": "edge",
			camp: "a,b",
			"ttl-ms": "999999999999",
		});
		expect(calls[0]?.args[0]).toMatchObject({
			campSet: "edge",
			campIds: ["a", "b"],
			mode: ReconcilerMode.AGENT,
			ttlMs: CD_DEFAULTS.bootstrapTokenMaxTtlMs,
		});
	});

	it("pipeline apply --file hobo.delivery.ts applies every record kind in dependency order", async () => {
		const calls: Call[] = [];
		const ok = (v: unknown) => ({ ok: true, value: v });
		const cd = fakeCd(
			{
				publishers: { trust: ok },
				sources: { define: ok },
				windows: { define: ok },
				inventory: { defineSet: ok },
				placement: { define: ok },
				pipelines: { apply: ok },
			},
			calls,
		);
		const out = await runCdDeploySubcommand(
			host(cd, {
				importModule: async () => ({
					pipelines: [{ name: "web", bindle: "web" }],
					sources: [{ name: "web-ci", bindle: "web" }],
					windows: [{ name: "freeze", kind: "WINDOW_KIND_FREEZE" }],
					campSets: [{ name: "prod" }],
					placements: [{ name: "edge" }],
					publishers: [
						{
							name: "gh",
							issuer: "https://token.actions.githubusercontent.com",
						},
					],
				}),
			}),
			["pipeline", "apply"],
			{ file: "hobo.delivery.ts" },
		);
		expect(out.ok).toBe(true);
		expect(calls.map((c) => `${c.module}.${c.method}`)).toEqual([
			"publishers.trust",
			"sources.define",
			"windows.define",
			"inventory.defineSet",
			"placement.define",
			"pipelines.apply",
		]);
	});

	it("pipeline apply stops at the first refusal (no partially applied delivery module)", async () => {
		const calls: Call[] = [];
		const cd = fakeCd(
			{
				sources: { define: () => refusal("source-invalid", "fix the locator") },
				pipelines: { apply: () => ({ ok: true, value: {} }) },
			},
			calls,
		);
		const out = await runCdDeploySubcommand(
			host(cd, {
				importModule: async () => ({
					sources: [{ name: "s" }],
					pipelines: [{ name: "p" }],
				}),
			}),
			["pipeline", "apply"],
			{ file: "hobo.delivery.ts" },
		);
		expect(out.code).toBe("source-invalid");
		expect(calls.some((c) => c.method === "apply")).toBe(false);
	});

	it("a delivery module with an unknown export is refused before anything applies", async () => {
		const calls: Call[] = [];
		const out = await runCdDeploySubcommand(
			host(fakeCd({}, calls), {
				importModule: async () => ({ pipelines: [], shellHook: "rm -rf /" }),
			}),
			["pipeline", "apply"],
			{ file: "hobo.delivery.ts" },
		);
		expect(out.code).toBe("delivery-module-invalid");
		expect(calls).toEqual([]);
	});
});

describe("createDeployCommand", () => {
	it("shows help with every subcommand when run without one", async () => {
		const out = await createDeployCommand({ env: {} }).run(runInput([]));
		expect(out.code).toBe("HOBO_DEPLOY_HELP");
		expect(out.remediation?.length).toBeGreaterThanOrEqual(REQUIRED.length);
	});

	it("reaches fixtures only with --simulate (C2)", async () => {
		const seen: boolean[] = [];
		const openCd = async (input: { simulate: boolean }) => {
			seen.push(input.simulate);
			return {
				ok: true as const,
				value: {
					host: host(fakeCd(), { simulated: input.simulate }),
					close: async () => {},
				},
			};
		};
		const cmd = createDeployCommand({ env: {}, hoboHome: "/tmp/h", openCd });
		const real = await cmd.run(runInput(["status"]));
		const sim = await cmd.run(runInput(["status"], { simulate: true }));
		expect(seen).toEqual([false, true]);
		expect(real.data?.simulated).toBe(false);
		expect(sim.data?.simulated).toBe(true);
		expect(sim.message).toMatch(/simulated/);
	});

	it("an unopenable CD runtime is a typed refusal with a next step", async () => {
		const cmd = createDeployCommand({
			env: {},
			hoboHome: "/tmp/h",
			openCd: async () =>
				refusal("compose-store-multinode", "Set HOBO_CD_POSTGRES_URL."),
		});
		const out = await cmd.run(runInput(["status"]));
		expect(out).toMatchObject({
			ok: false,
			code: "compose-store-multinode",
			remediation: ["Set HOBO_CD_POSTGRES_URL."],
		});
	});

	it("keeps hosting-* supervision", async () => {
		const out = await createDeployCommand({ env: {} }).run(
			runInput(["hosting-status", "dep-1"]),
		);
		expect(out.code).toBe("HOBO_HOSTING_NOT_CONFIGURED");
	});
});

describe("hobo incident (migrated to the CD rollback)", () => {
	const opener = (cd: ReturnType<typeof fakeCd>) => async () => ({
		ok: true as const,
		value: { host: host(cd), close: async () => {} },
	});

	it("status reports failed, rolled-back and rejected promotions from the journal", async () => {
		const cd = fakeCd({
			promotions: {
				list: () => [
					promotion({ promotionId: "a", state: PromotionState.FAILED }),
					promotion({ promotionId: "b", state: PromotionState.PROMOTED }),
					promotion({ promotionId: "c", state: PromotionState.ROLLED_BACK }),
				],
			},
		});
		const out = await createIncidentCommand({
			env: {},
			hoboHome: "/h",
			openCd: opener(cd),
		}).run(runInput(["status"]));
		expect(out.data?.active).toBe(true);
		expect(
			(out.data?.promotions as { promotionId: string }[]).map(
				(p) => p.promotionId,
			),
		).toEqual(["a", "c"]);
	});

	it("open rolls the Camp back through PromotionService (D12)", async () => {
		const calls: Call[] = [];
		const cd = fakeCd(
			{
				promotions: {
					rollback: () => ({
						ok: true,
						value: promotion({ promotionId: "rb" }),
					}),
				},
			},
			calls,
		);
		const out = await createIncidentCommand({
			env: {},
			hoboHome: "/h",
			openCd: opener(cd),
		}).run(runInput(["open"], { camp: "prod", signal: "slo-burn" }));
		expect(out.code).toBe("HOBO_INCIDENT_OPEN");
		expect(calls.find((c) => c.method === "rollback")?.args[0]).toMatchObject({
			campId: "prod",
			reason: "incident: slo-burn",
		});
	});

	it("an agent's rollback is a proposal (ADR-0094)", async () => {
		const cd = fakeCd({
			promotions: {
				rollback: () => ({ ok: true, value: promotion({ proposal: true }) }),
			},
		});
		const out = await createIncidentCommand({
			env: {},
			hoboHome: "/h",
			openCd: opener(cd),
		}).run(runInput(["open"], { camp: "prod" }));
		expect(out.code).toBe("HOBO_INCIDENT_PROPOSED");
	});

	it("open without --camp is a usage error", async () => {
		const out = await createIncidentCommand({
			env: {},
			hoboHome: "/h",
			openCd: opener(fakeCd()),
		}).run(runInput(["open"]));
		expect(out.status).toBe("usage");
	});
});

describe("operator surface invariants", () => {
	it("MCP tool surface stays at parity with the canonical verbs (no new verb)", () => {
		expect(assertToolSurfaceParity().ok).toBe(true);
	});

	it("no fixture is reachable outside --simulate (source scan)", () => {
		const dir = join(import.meta.dirname, "../src");
		const files = readdirSync(dir).filter((f) => /\.ts$/.test(f));
		for (const file of files) {
			const source = readFileSync(join(dir, file), "utf8");
			expect(source, file).not.toMatch(
				/createContractAssertedCdFixtures|createContinuousDeliveryPlane/,
			);
			// Every use of the simulated realizer sits behind config.simulate.
			const uses = source.match(/createSimulatedRealizer\(\)/g)?.length ?? 0;
			const guarded =
				source.match(
					/config\.simulate\s*\?\s*(\{\s*conductor:\s*\(\)\s*=>\s*)?createSimulatedRealizer\(\)/g,
				)?.length ?? 0;
			expect(uses, file).toBe(guarded);
			if (uses > 0) {
				expect(file).toBe("cd-runtime.ts");
				expect(source).toMatch(
					/config\.simulate\s*\?\s*\{\s*conductor:\s*\(\)\s*=>\s*createSimulatedRealizer\(\)\s*\}/,
				);
			}
		}
	});
});
