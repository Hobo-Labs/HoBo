/**
 * `hobo deploy` CD subcommands (WP18, plan 0024, C2).
 *
 * Every subcommand is a thin, typed call into the composed
 * `ContinuousDelivery` facade (`@hobo/cd/compose`): this file parses flags,
 * calls one module method, and renders the result. It makes no delivery
 * decision and holds no fixture: the facade it receives is the real one, or
 * the labelled `--simulate` one the caller composed.
 *
 * `deploy` stays the one canonical verb; these are its subcommands.
 */

import { create } from "@bufbuild/protobuf";
import {
	type CampId,
	CampManagement,
	type CampReconciler,
	CD_DEFAULTS,
	type CdAction,
	type CdContext,
	type ContinuousDelivery,
	type FailoverId,
	type FanoutId,
	type FreightId,
	FreightOrigin,
	type FreightRecord,
	type Outcome,
	ReasonRecordSchema,
	type ReconcilerId,
	ReconcilerMode,
	RolloutStrategy,
	type SetId,
	SignalSource,
	TaintEffect,
	TaintRecordSchema,
	type VerificationId,
	WindowOverrideRecordSchema,
} from "@hobo/cd";
import type { CommandResult } from "@hobo/cli";
import {
	type DeliveryModule,
	deliveryRecordCount,
	loadDeliveryFile,
	loadRecordsOf,
	type ModuleImporter,
} from "./cd-delivery-module.js";
import {
	type CdFormat,
	cdOk,
	cdRefused,
	cdUsage,
	parseCdFormat,
} from "./cd-render.js";
import { isJsonNumber, isJsonString, type JsonObject } from "./json.js";

/** What the subcommands run against. */
export interface CdDeployHost {
	readonly cd: ContinuousDelivery;
	readonly ctx: CdContext;
	readonly cwd: string;
	/** True when composed with --simulate; echoed in every result. */
	readonly simulated: boolean;
	/** One in-process conductor for these Camps (`deploy reconcile`). */
	readonly conductor?: (campIds: readonly CampId[]) => CampReconciler;
	/** Run this process as an agent-mode reconciler until aborted (`deploy agent run`). */
	readonly runAgent?: (
		input: Readonly<{ flags: JsonObject }>,
	) => Promise<Outcome<Readonly<{ reconcilerId: string; stoppedAt: string }>>>;
	readonly importModule?: ModuleImporter;
}

type Run = (
	host: CdDeployHost,
	args: readonly string[],
	flags: JsonObject,
	format: CdFormat,
) => Promise<CommandResult>;

type Sub = Readonly<{ usage: string; summary: string; run: Run }>;

// ── Flag parsing (parse, don't validate) ─────────────────────────────────

function text(flags: JsonObject, name: string): string | undefined {
	const v = flags[name];
	return isJsonString(v) && v.trim() !== "" ? v.trim() : undefined;
}

function list(flags: JsonObject, name: string): readonly string[] {
	const v = flags[name];
	if (Array.isArray(v)) return v.filter(isJsonString).flatMap(splitList);
	return isJsonString(v) ? splitList(v) : [];
}

function splitList(v: string): string[] {
	return v
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");
}

function num(flags: JsonObject, name: string): number | undefined {
	const v = flags[name];
	if (isJsonNumber(v)) return v;
	if (isJsonString(v) && /^\d+$/.test(v.trim())) return Number(v.trim());
	return undefined;
}

function bool(flags: JsonObject, name: string): boolean {
	const v = flags[name];
	return v === true || v === "true";
}

// SAFETY: CLI arguments are opaque ids; the owning module parses and refuses unknown ones.
const asCamp = (id: string) => id as CampId;
// SAFETY: see asCamp.
const asFreight = (id: string) => id as FreightId;

class Usage extends Error {
	constructor(
		message: string,
		readonly usage: string,
	) {
		super(message);
	}
}

function need(value: string | undefined, what: string, usage: string): string {
	if (value === undefined) throw new Usage(`missing ${what}`, usage);
	return value;
}

function oneOf<T>(
	value: string | undefined,
	table: Readonly<Record<string, T>>,
	what: string,
	usage: string,
): T {
	const key = need(value, what, usage).toUpperCase().replace(/-/g, "_");
	const hit = table[key];
	if (hit === undefined)
		throw new Usage(
			`${what} must be one of ${Object.keys(table).join("|")}`,
			usage,
		);
	return hit;
}

const STRATEGIES = {
	ALL_AT_ONCE: RolloutStrategy.ALL_AT_ONCE,
	CANARY: RolloutStrategy.CANARY,
	BLUE_GREEN: RolloutStrategy.BLUE_GREEN,
	EXPERIMENT: RolloutStrategy.EXPERIMENT,
} as const;

const EFFECTS = {
	NO_PLACE: TaintEffect.NO_PLACE,
	NO_RUN: TaintEffect.NO_RUN,
} as const;

const MANAGEMENT = {
	MANAGED: CampManagement.MANAGED,
	OBSERVE_ONLY: CampManagement.OBSERVE_ONLY,
} as const;

const MODES = {
	CONDUCTOR: ReconcilerMode.CONDUCTOR,
	AGENT: ReconcilerMode.AGENT,
	PUBLISHER: ReconcilerMode.PUBLISHER,
} as const;

/** Deterministic idempotency key (I12): the same request twice is one request. */
function idempotencyKey(
	flags: JsonObject,
	...parts: readonly (string | undefined)[]
): string {
	return (
		text(flags, "idempotency-key") ??
		text(flags, "idempotencyKey") ??
		parts.map((p) => p ?? "").join("|")
	);
}

// ── Result helpers ─────────────────────────────────────────────────────────

function outcome<T>(
	host: CdDeployHost,
	sub: string,
	format: CdFormat,
	result: Outcome<T>,
	ok: (value: T) => Readonly<{
		code: string;
		summary: string;
		data: Readonly<Record<string, unknown>>;
	}>,
): CommandResult {
	if (!result.ok)
		return cdRefused({ reasons: result.reasons, subcommand: sub, format });
	const shaped = ok(result.value);
	return cdOk({
		...shaped,
		format,
		data: {
			command: "deploy",
			subcommand: sub,
			simulated: host.simulated,
			...shaped.data,
		},
	});
}

function done(
	host: CdDeployHost,
	sub: string,
	format: CdFormat,
	code: string,
	summary: string,
	data: Readonly<Record<string, unknown>>,
): CommandResult {
	return cdOk({
		code,
		summary,
		format,
		data: {
			command: "deploy",
			subcommand: sub,
			simulated: host.simulated,
			...data,
		},
	});
}

function notFound(
	sub: string,
	format: CdFormat,
	what: string,
	id: string,
	next: string,
): CommandResult {
	return cdRefused({
		subcommand: sub,
		format,
		reasons: [
			create(ReasonRecordSchema, {
				code: "cd-not-found",
				message: `${what} ${id} not found`,
				remediation: next,
				subject: id,
			}),
		],
	});
}

async function freightOf(
	cd: ContinuousDelivery,
	ref: string,
): Promise<FreightRecord | undefined> {
	return (
		(await cd.freight.get(asFreight(ref))) ?? (await cd.freight.getByAlias(ref))
	);
}

async function applyModule(
	host: CdDeployHost,
	module: DeliveryModule,
): Promise<Outcome<Readonly<Record<string, number>>>> {
	const { cd, ctx } = host;
	const steps: readonly (() => Promise<Outcome<unknown>>)[] = [
		...module.publishers.map((p) => () => cd.publishers.trust(p, ctx)),
		...module.sources.map((s) => () => cd.sources.define(s, ctx)),
		...module.windows.map((w) => () => cd.windows.define(w, ctx)),
		...module.campSets.map((s) => () => cd.inventory.defineSet(s, ctx)),
		...module.placements.map((p) => () => cd.placement.define(p, ctx)),
		...module.pipelines.map((p) => () => cd.pipelines.apply(p, ctx)),
	];
	for (const step of steps) {
		const result = await step();
		if (!result.ok) return result;
	}
	return {
		ok: true,
		value: {
			publishers: module.publishers.length,
			sources: module.sources.length,
			windows: module.windows.length,
			campSets: module.campSets.length,
			placements: module.placements.length,
			pipelines: module.pipelines.length,
		},
	};
}

function moduleRefusal(
	sub: string,
	format: CdFormat,
	r: { code: string; message: string; remediation: string },
): CommandResult {
	return cdRefused({
		subcommand: sub,
		format,
		reasons: [
			create(ReasonRecordSchema, {
				code: r.code,
				message: r.message,
				remediation: r.remediation,
			}),
		],
	});
}

function defineFrom<K extends keyof DeliveryModule>(
	kind: K,
	sub: string,
	code: string,
	apply: (
		host: CdDeployHost,
		record: DeliveryModule[K][number],
	) => Promise<Outcome<unknown>>,
): Run {
	return async (host, _args, flags, format) => {
		const usage = `hobo deploy ${sub} --file <record.json|hobo.delivery.ts>`;
		const file = need(text(flags, "file"), "--file", usage);
		const loaded = await loadRecordsOf(kind, file, {
			cwd: host.cwd,
			...(host.importModule ? { importModule: host.importModule } : undefined),
		});
		if (!loaded.ok) return moduleRefusal(sub, format, loaded);
		const records: readonly DeliveryModule[K][number][] = loaded.value;
		if (records.length === 0)
			throw new Usage(`${file} holds no ${kind}`, usage);
		const applied: unknown[] = [];
		for (const record of records) {
			const result = await apply(host, record);
			if (!result.ok)
				return cdRefused({ reasons: result.reasons, subcommand: sub, format });
			applied.push(result.value);
		}
		return done(
			host,
			sub,
			format,
			code,
			`${sub}: ${applied.length} record(s) applied`,
			{ records: applied },
		);
	};
}

// ── Subcommands ────────────────────────────────────────────────────────────

export const CD_DEPLOY_SUBCOMMANDS: Readonly<Record<string, Sub>> =
	Object.freeze({
		"freight record": {
			usage: "hobo deploy freight record --file <freight-manifest.json>",
			summary:
				"Record Freight from a hobo.freight-manifest/v1 manifest (principal-authenticated push)",
			run: async (host, _args, flags, format) => {
				const usage = CD_DEPLOY_SUBCOMMANDS["freight record"]?.usage ?? "";
				const file = need(text(flags, "file"), "--file", usage);
				const { readFile } = await import("node:fs/promises");
				const { resolve } = await import("node:path");
				const { fromJson } = await import("@bufbuild/protobuf");
				const { FreightManifestRecordSchema } = await import("@hobo/cd");
				let manifest: ReturnType<
					typeof create<typeof FreightManifestRecordSchema>
				>;
				try {
					manifest = fromJson(
						FreightManifestRecordSchema,
						JSON.parse(await readFile(resolve(host.cwd, file), "utf8")),
					);
				} catch (error) {
					return moduleRefusal("freight record", format, {
						code: "freight-manifest-invalid",
						message: error instanceof Error ? error.message : String(error),
						remediation:
							"Write the manifest with writeFreightManifest (@hobo/cd/ingest) or any build that emits hobo.freight-manifest/v1.",
					});
				}
				const result = await host.cd.ingest.manifest({ manifest }, host.ctx);
				return outcome(host, "freight record", format, result, (freight) => ({
					code: "HOBO_CD_FREIGHT_RECORDED",
					summary: `freight ${freight.alias} (${freight.freightId}) recorded`,
					data: { freight, origin: FreightOrigin[freight.origin] },
				}));
			},
		},
		"freight list": {
			usage: "hobo deploy freight list [--bindle <name>] [--limit <n>]",
			summary: "List Freight, newest first",
			run: async (host, _args, flags, format) => {
				const bindle = text(flags, "bindle");
				const limit = num(flags, "limit");
				const freight = await host.cd.freight.list({
					...(bindle ? { bindle } : undefined),
					...(limit !== undefined ? { limit } : undefined),
				});
				return done(
					host,
					"freight list",
					format,
					"HOBO_CD_FREIGHT_LIST",
					`${freight.length} freight`,
					{ freight },
				);
			},
		},
		"freight show": {
			usage: "hobo deploy freight show <freight-id|alias>",
			summary: "Show one Freight with its qualifications and approvals",
			run: async (host, args, _flags, format) => {
				const ref = need(
					args[0],
					"<freight-id|alias>",
					CD_DEPLOY_SUBCOMMANDS["freight show"]?.usage ?? "",
				);
				const freight = await freightOf(host.cd, ref);
				if (!freight)
					return notFound(
						"freight show",
						format,
						"freight",
						ref,
						"hobo deploy freight list",
					);
				const id = asFreight(freight.freightId);
				return done(
					host,
					"freight show",
					format,
					"HOBO_CD_FREIGHT",
					`freight ${freight.alias}`,
					{
						freight,
						usable: await host.cd.freight.isUsable(id),
						qualifications: await host.cd.freight.qualifications(id),
						approvals: await host.cd.freight.approvals(id),
					},
				);
			},
		},
		"freight yank": {
			usage: "hobo deploy freight yank <freight-id|alias> --reason <text>",
			summary: "Yank Freight: it never starts or continues a promotion (I13)",
			run: async (host, args, flags, format) => {
				const usage = CD_DEPLOY_SUBCOMMANDS["freight yank"]?.usage ?? "";
				const ref = need(args[0], "<freight-id|alias>", usage);
				const reason = need(text(flags, "reason"), "--reason", usage);
				const freight = await freightOf(host.cd, ref);
				if (!freight)
					return notFound(
						"freight yank",
						format,
						"freight",
						ref,
						"hobo deploy freight list",
					);
				const result = await host.cd.freight.yank(
					asFreight(freight.freightId),
					reason,
					host.ctx,
				);
				return outcome(host, "freight yank", format, result, (f) => ({
					code: "HOBO_CD_FREIGHT_YANKED",
					summary: `freight ${f.alias} yanked`,
					data: { freight: f },
				}));
			},
		},
		"freight approve": {
			usage:
				"hobo deploy freight approve <freight-id|alias> --camp <camp> --reason <text> [--ttl-ms <ms>]",
			summary:
				"Hotfix: an audited, expiring bypass of lineage for one Camp (D4)",
			run: async (host, args, flags, format) => {
				const usage = CD_DEPLOY_SUBCOMMANDS["freight approve"]?.usage ?? "";
				const ref = need(args[0], "<freight-id|alias>", usage);
				const campId = asCamp(need(text(flags, "camp"), "--camp", usage));
				const reason = need(text(flags, "reason"), "--reason", usage);
				const ttl = Math.min(
					num(flags, "ttl-ms") ?? CD_DEFAULTS.approvalTtlMs,
					CD_DEFAULTS.hotfixApprovalMaxMs,
				);
				const freight = await freightOf(host.cd, ref);
				if (!freight)
					return notFound(
						"freight approve",
						format,
						"freight",
						ref,
						"hobo deploy freight list",
					);
				const result = await host.cd.freight.approve(
					{
						freightId: asFreight(freight.freightId),
						campId,
						reason,
						expiresAtMs: host.ctx.now() + ttl,
					},
					host.ctx,
				);
				return outcome(host, "freight approve", format, result, (approval) => ({
					code: "HOBO_CD_FREIGHT_APPROVED",
					summary: `freight ${freight.alias} approved for ${campId} until ${approval.expiresAt}`,
					data: { approval },
				}));
			},
		},
		"source define": {
			usage: "hobo deploy source define --file <source.json|hobo.delivery.ts>",
			summary: "Define a Freight source (pull discovery)",
			run: defineFrom(
				"sources",
				"source define",
				"HOBO_CD_SOURCE_DEFINED",
				(h, r) => h.cd.sources.define(r, h.ctx),
			),
		},
		"source list": {
			usage: "hobo deploy source list",
			summary: "List Freight sources",
			run: async (host, _args, _flags, format) => {
				const sources = await host.cd.sources.list();
				return done(
					host,
					"source list",
					format,
					"HOBO_CD_SOURCE_LIST",
					`${sources.length} source(s)`,
					{ sources },
				);
			},
		},
		"source poll": {
			usage: "hobo deploy source poll <name>",
			summary: "Poll a source now; returns the Freight discovered",
			run: async (host, args, _flags, format) => {
				const name = need(
					args[0],
					"<name>",
					CD_DEPLOY_SUBCOMMANDS["source poll"]?.usage ?? "",
				);
				const result = await host.cd.sources.poll(name, host.ctx);
				return outcome(host, "source poll", format, result, (freight) => ({
					code: "HOBO_CD_SOURCE_POLLED",
					summary: `source ${name}: ${freight.length} new freight`,
					data: { source: name, freight },
				}));
			},
		},
		"pipeline apply": {
			usage:
				"hobo deploy pipeline apply --file <pipeline.json|hobo.delivery.ts>",
			summary: "Apply a pipeline, or every record of a hobo.delivery.ts module",
			run: async (host, _args, flags, format) => {
				const usage = CD_DEPLOY_SUBCOMMANDS["pipeline apply"]?.usage ?? "";
				const file = need(text(flags, "file"), "--file", usage);
				const opts = {
					cwd: host.cwd,
					...(host.importModule
						? { importModule: host.importModule }
						: undefined),
				};
				const isJson = file.endsWith(".json");
				const loaded = isJson
					? await loadRecordsOf("pipelines", file, opts).then((r) =>
							r.ok
								? {
										ok: true as const,
										value: {
											sources: [],
											pipelines: r.value,
											windows: [],
											campSets: [],
											placements: [],
											publishers: [],
										},
									}
								: r,
						)
					: await loadDeliveryFile(file, opts);
				// A JSON exports object may carry more than pipelines; re-read it whole.
				const module =
					isJson && loaded.ok && loaded.value.pipelines.length === 0
						? await loadDeliveryFile(file, opts)
						: loaded;
				if (!module.ok) return moduleRefusal("pipeline apply", format, module);
				if (deliveryRecordCount(module.value) === 0)
					throw new Usage(`${file} holds no delivery records`, usage);
				const applied = await applyModule(host, module.value);
				return outcome(host, "pipeline apply", format, applied, (counts) => ({
					code: "HOBO_CD_PIPELINE_APPLIED",
					summary: `applied ${Object.entries(counts)
						.filter(([, n]) => n > 0)
						.map(([k, n]) => `${n} ${k}`)
						.join(", ")}`,
					data: { applied: counts },
				}));
			},
		},
		"pipeline show": {
			usage: "hobo deploy pipeline show <name>",
			summary: "Show a pipeline and the Freight available to each node",
			run: async (host, args, _flags, format) => {
				const name = need(
					args[0],
					"<name>",
					CD_DEPLOY_SUBCOMMANDS["pipeline show"]?.usage ?? "",
				);
				const pipeline = await host.cd.pipelines.get(name);
				if (!pipeline)
					return notFound(
						"pipeline show",
						format,
						"pipeline",
						name,
						"hobo deploy pipeline list",
					);
				const available: Record<string, unknown> = {};
				for (const node of pipeline.nodes)
					available[node.name] = await host.cd.pipelines.available({
						pipeline: name,
						node: node.name,
					});
				return done(
					host,
					"pipeline show",
					format,
					"HOBO_CD_PIPELINE",
					`pipeline ${name}`,
					{ pipeline, available },
				);
			},
		},
		"pipeline list": {
			usage: "hobo deploy pipeline list",
			summary: "List pipelines",
			run: async (host, _args, _flags, format) => {
				const pipelines = await host.cd.pipelines.list();
				return done(
					host,
					"pipeline list",
					format,
					"HOBO_CD_PIPELINE_LIST",
					`${pipelines.length} pipeline(s)`,
					{ pipelines },
				);
			},
		},
		"window define": {
			usage: "hobo deploy window define --file <window.json|hobo.delivery.ts>",
			summary: "Define a change window (ALLOW/FREEZE)",
			run: defineFrom(
				"windows",
				"window define",
				"HOBO_CD_WINDOW_DEFINED",
				(h, r) => h.cd.windows.define(r, h.ctx),
			),
		},
		"window list": {
			usage: "hobo deploy window list",
			summary: "List change windows",
			run: async (host, _args, _flags, format) => {
				const windows = await host.cd.windows.list();
				return done(
					host,
					"window list",
					format,
					"HOBO_CD_WINDOW_LIST",
					`${windows.length} window(s)`,
					{ windows },
				);
			},
		},
		"window override": {
			usage:
				"hobo deploy window override <window> --camp <a,b> --reason <text> [--ttl-ms <ms>]",
			summary: "Governed, expiring, audited window override (D10)",
			run: async (host, args, flags, format) => {
				const usage = CD_DEPLOY_SUBCOMMANDS["window override"]?.usage ?? "";
				const window = need(args[0], "<window>", usage);
				const campIds = list(flags, "camp");
				if (campIds.length === 0) throw new Usage("missing --camp", usage);
				const reason = need(text(flags, "reason"), "--reason", usage);
				const ttl = Math.min(
					num(flags, "ttl-ms") ?? CD_DEFAULTS.windowOverrideMaxMs,
					CD_DEFAULTS.windowOverrideMaxMs,
				);
				const result = await host.cd.windows.override(
					create(WindowOverrideRecordSchema, {
						window,
						campIds: [...campIds],
						reason,
						expiresAt: new Date(host.ctx.now() + ttl).toISOString(),
					}),
					host.ctx,
				);
				return outcome(host, "window override", format, result, (override) => ({
					code: "HOBO_CD_WINDOW_OVERRIDDEN",
					summary: `window ${window} overridden for ${campIds.join(", ")} until ${override.expiresAt}`,
					data: { override },
				}));
			},
		},
		promote: {
			usage:
				"hobo deploy promote <freight-id|alias> --camp <a,b> [--pipeline <p> --node <n>] [--strategy canary|blue-green|all-at-once|experiment] [--propose]",
			summary:
				"Promote Freight (Rail Freight included) into Camps through the gate",
			run: async (host, args, flags, format) => {
				const usage = CD_DEPLOY_SUBCOMMANDS.promote?.usage ?? "";
				const ref = need(args[0], "<freight-id|alias>", usage);
				const targets = list(flags, "camp").map(asCamp);
				if (targets.length === 0) throw new Usage("missing --camp", usage);
				const freight = await freightOf(host.cd, ref);
				if (!freight)
					return notFound(
						"promote",
						format,
						"freight",
						ref,
						"hobo deploy freight list",
					);
				const pipeline = text(flags, "pipeline");
				const node = text(flags, "node");
				const source = text(flags, "source-camp");
				const strategyFlag = text(flags, "strategy");
				const result = await host.cd.promotions.promote(
					{
						freightId: asFreight(freight.freightId),
						targets,
						idempotencyKey: idempotencyKey(
							flags,
							"promote",
							freight.freightId,
							[...targets].sort().join(","),
							pipeline,
							node,
						),
						...(pipeline ? { pipeline } : undefined),
						...(node ? { node } : undefined),
						...(source ? { sourceCampId: asCamp(source) } : undefined),
						...(strategyFlag
							? {
									strategy: oneOf(
										strategyFlag,
										STRATEGIES,
										"--strategy",
										usage,
									),
								}
							: undefined),
						...(bool(flags, "propose") ? { proposal: true } : undefined),
					},
					host.ctx,
				);
				return outcome(host, "promote", format, result, (promotion) => ({
					code: promotion.proposal
						? "HOBO_CD_PROMOTION_PROPOSED"
						: "HOBO_CD_PROMOTION_REQUESTED",
					summary: `${promotion.proposal ? "proposed" : "promotion"} ${promotion.promotionId} of ${freight.alias} → ${targets.join(", ")}`,
					data: { promotion },
				}));
			},
		},
		status: {
			usage: "hobo deploy status [--camp <a,b>] [--limit <n>]",
			summary: "Desired Set, last observation and promotions per Camp",
			run: async (host, _args, flags, format) => {
				const camps = list(flags, "camp").map(asCamp);
				const limit = num(flags, "limit") ?? 20;
				const targets =
					camps.length > 0
						? camps
						: (await host.cd.inventory.list()).map((v) => v.topology.campId);
				const rows = [];
				for (const campId of targets) {
					rows.push({
						campId,
						desired: await host.cd.desired.current(campId),
						observed: await host.cd.desired.status(campId),
						inventory: await host.cd.inventory.status(campId),
						promotions: await host.cd.promotions.list({ campId, limit }),
					});
				}
				return done(
					host,
					"status",
					format,
					"HOBO_CD_STATUS",
					`${rows.length} camp(s)${host.simulated ? " (simulated)" : ""}`,
					{ camps: rows },
				);
			},
		},
		logs: {
			usage: "hobo deploy logs --camp <camp> [--limit <n>]",
			summary: "Set history and promotion timeline for a Camp",
			run: async (host, _args, flags, format) => {
				const usage = CD_DEPLOY_SUBCOMMANDS.logs?.usage ?? "";
				const campId = asCamp(need(text(flags, "camp"), "--camp", usage));
				const limit = num(flags, "limit") ?? 50;
				const sets = await host.cd.desired.history(campId, limit);
				const promotions = await host.cd.promotions.list({ campId, limit });
				return done(
					host,
					"logs",
					format,
					"HOBO_CD_LOGS",
					`${sets.length} set(s), ${promotions.length} promotion(s) for ${campId}`,
					{
						campId,
						sets,
						promotions,
						observed: await host.cd.desired.status(campId),
					},
				);
			},
		},
		rollback: {
			usage:
				"hobo deploy rollback --camp <camp> --reason <text> [--to <set-id>]",
			summary:
				"Zero exposure, then a Delta to the predecessor Set through the same gate (D12)",
			run: async (host, _args, flags, format) => {
				const usage = CD_DEPLOY_SUBCOMMANDS.rollback?.usage ?? "";
				const campId = asCamp(need(text(flags, "camp"), "--camp", usage));
				const reason = need(text(flags, "reason"), "--reason", usage);
				const to = text(flags, "to");
				const result = await host.cd.promotions.rollback(
					{
						campId,
						reason,
						idempotencyKey: idempotencyKey(
							flags,
							"rollback",
							campId,
							to,
							reason,
						),
						// SAFETY: an opaque Set id the Delta ledger verifies.
						...(to ? { toSetId: to as SetId } : undefined),
					},
					host.ctx,
				);
				return outcome(host, "rollback", format, result, (promotion) => ({
					code: "HOBO_CD_ROLLBACK_REQUESTED",
					summary: `rollback ${promotion.promotionId} for ${campId}`,
					data: { promotion },
				}));
			},
		},
		reconcile: {
			usage: "hobo deploy reconcile --camp <camp>",
			summary: "One bounded conductor pass for a Camp (fenced lease)",
			run: async (host, _args, flags, format) => {
				const usage = CD_DEPLOY_SUBCOMMANDS.reconcile?.usage ?? "";
				const campId = asCamp(need(text(flags, "camp"), "--camp", usage));
				if (!host.conductor)
					return moduleRefusal("reconcile", format, {
						code: "compose-realizer-missing",
						message: "no conductor realizer is composed in this process",
						remediation:
							"Configure a conductor realizer (see packages/hobo/CD.md), run `hobo serve cd`, or pass --simulate.",
					});
				let reconciler: CampReconciler;
				try {
					reconciler = host.conductor([campId]);
				} catch (error) {
					const code = (error as { code?: unknown }).code;
					return moduleRefusal("reconcile", format, {
						code: typeof code === "string" ? code : "compose-realizer-missing",
						message: error instanceof Error ? error.message : String(error),
						remediation:
							(error as { remediation?: string }).remediation ??
							"Configure a conductor realizer.",
					});
				}
				const observation = await reconciler.reconcileOnce(campId, host.ctx);
				return done(
					host,
					"reconcile",
					format,
					"HOBO_CD_RECONCILED",
					`camp ${campId} reconciled`,
					{ observation },
				);
			},
		},
		"preview create": {
			usage:
				"hobo deploy preview create <freight-id|alias> --source-camp <camp> [--ttl-ms <ms>]",
			summary: "Create an ephemeral preview Camp",
			run: async (host, args, flags, format) => {
				const usage = CD_DEPLOY_SUBCOMMANDS["preview create"]?.usage ?? "";
				const ref = need(args[0], "<freight-id|alias>", usage);
				const source = asCamp(
					need(text(flags, "source-camp"), "--source-camp", usage),
				);
				const ttlMs = num(flags, "ttl-ms") ?? CD_DEFAULTS.approvalTtlMs;
				const freight = await freightOf(host.cd, ref);
				if (!freight)
					return notFound(
						"preview create",
						format,
						"freight",
						ref,
						"hobo deploy freight list",
					);
				const pipeline = text(flags, "pipeline");
				const node = text(flags, "node");
				const result = await host.cd.promotions.createPreview(
					{
						freightId: asFreight(freight.freightId),
						sourceCampId: source,
						ttlMs,
						idempotencyKey: idempotencyKey(
							flags,
							"preview",
							freight.freightId,
							source,
						),
						...(pipeline ? { pipeline } : undefined),
						...(node ? { node } : undefined),
					},
					host.ctx,
				);
				return outcome(host, "preview create", format, result, (preview) => ({
					code: "HOBO_CD_PREVIEW_CREATED",
					summary: `preview ${preview.campId} expires ${preview.expiresAt}`,
					data: { preview },
				}));
			},
		},
		"preview list": {
			usage: "hobo deploy preview list",
			summary: "List preview Camps",
			run: async (host, _args, _flags, format) => {
				const previews = await host.cd.promotions.listPreviews();
				return done(
					host,
					"preview list",
					format,
					"HOBO_CD_PREVIEW_LIST",
					`${previews.length} preview(s)`,
					{ previews },
				);
			},
		},
		"verify show": {
			usage: "hobo deploy verify show <verification-id>",
			summary: "Show a verification result",
			run: async (host, args, _flags, format) => {
				const id = need(
					args[0],
					"<verification-id>",
					CD_DEPLOY_SUBCOMMANDS["verify show"]?.usage ?? "",
				);
				// SAFETY: an opaque verification id.
				const result = await host.cd.verification.get(id as VerificationId);
				if (!result)
					return notFound(
						"verify show",
						format,
						"verification",
						id,
						"hobo deploy status --camp <camp>",
					);
				return done(
					host,
					"verify show",
					format,
					"HOBO_CD_VERIFICATION",
					`verification ${id}`,
					{ verification: result },
				);
			},
		},
		"agent token": {
			usage:
				"hobo deploy agent token --camp-set <set> --camp <a,b> [--mode agent|publisher] [--ttl-ms <ms>]",
			summary:
				"Issue a single-use bootstrap token scoped to one Camp set (D19)",
			run: async (host, _args, flags, format) => {
				const usage = CD_DEPLOY_SUBCOMMANDS["agent token"]?.usage ?? "";
				const campSet = need(text(flags, "camp-set"), "--camp-set", usage);
				const ttlMs = Math.min(
					num(flags, "ttl-ms") ?? CD_DEFAULTS.bootstrapTokenTtlMs,
					CD_DEFAULTS.bootstrapTokenMaxTtlMs,
				);
				const mode = oneOf(
					text(flags, "mode") ?? "agent",
					MODES,
					"--mode",
					usage,
				);
				const result = await host.cd.enrollment.issueToken(
					{ campSet, campIds: list(flags, "camp").map(asCamp), mode, ttlMs },
					host.ctx,
				);
				return outcome(host, "agent token", format, result, (token) => ({
					code: "HOBO_CD_AGENT_TOKEN",
					summary: `bootstrap token for ${campSet}, single use, expires ${new Date(token.expiresAtMs).toISOString()}`,
					data: { token: token.token, expiresAtMs: token.expiresAtMs, campSet },
				}));
			},
		},
		"agent enroll": {
			usage:
				"hobo deploy agent enroll --token <bootstrap> --jwk-file <public.jwk.json>",
			summary: "Enroll an agent's public key; PENDING until both grants (I24)",
			run: async (host, _args, flags, format) => {
				const usage = CD_DEPLOY_SUBCOMMANDS["agent enroll"]?.usage ?? "";
				const token = need(text(flags, "token"), "--token", usage);
				const jwkFile = need(text(flags, "jwk-file"), "--jwk-file", usage);
				const { readFile } = await import("node:fs/promises");
				const { resolve } = await import("node:path");
				let publicJwk: JsonObject;
				try {
					const parsed: unknown = JSON.parse(
						await readFile(resolve(host.cwd, jwkFile), "utf8"),
					);
					if (
						typeof parsed !== "object" ||
						parsed === null ||
						Array.isArray(parsed) ||
						"d" in parsed
					)
						throw new Error(
							"expected a public JWK object (no private member `d`)",
						);
					// SAFETY: checked to be a JSON object above.
					publicJwk = parsed as JsonObject;
				} catch (error) {
					return moduleRefusal("agent enroll", format, {
						code: "agent-jwk-invalid",
						message: error instanceof Error ? error.message : String(error),
						remediation:
							"Pass the agent's PUBLIC JWK; the private key never leaves the agent.",
					});
				}
				const result = await host.cd.enrollment.enroll(
					{ token, publicJwk, claims: [] },
					host.ctx,
				);
				return outcome(host, "agent enroll", format, result, (r) => ({
					code: "HOBO_CD_AGENT_ENROLLED",
					summary: `agent ${r.reconciler.reconcilerId} enrolled; next: agent approve-key and agent accept`,
					data: { reconciler: r.reconciler, state: r.state },
				}));
			},
		},
		"agent approve-key": {
			usage: "hobo deploy agent approve-key <reconciler-id>",
			summary: "Grant 1: the key belongs to a legitimate agent",
			run: async (host, args, _flags, format) => {
				const id = need(
					args[0],
					"<reconciler-id>",
					CD_DEPLOY_SUBCOMMANDS["agent approve-key"]?.usage ?? "",
				);
				// SAFETY: an opaque reconciler id the enrollment ledger verifies.
				const result = await host.cd.enrollment.approveKey(
					id as ReconcilerId,
					host.ctx,
				);
				return outcome(
					host,
					"agent approve-key",
					format,
					result,
					(reconciler) => ({
						code: "HOBO_CD_AGENT_KEY_APPROVED",
						summary: `agent ${id} key approved`,
						data: { reconciler },
					}),
				);
			},
		},
		"agent accept": {
			usage: "hobo deploy agent accept <reconciler-id> --camp <a,b>",
			summary: "Grant 2: the agent may serve these Camps",
			run: async (host, args, flags, format) => {
				const usage = CD_DEPLOY_SUBCOMMANDS["agent accept"]?.usage ?? "";
				const id = need(args[0], "<reconciler-id>", usage);
				const campIds = list(flags, "camp").map(asCamp);
				if (campIds.length === 0) throw new Usage("missing --camp", usage);
				// SAFETY: see agent approve-key.
				const result = await host.cd.enrollment.accept(
					{ reconcilerId: id as ReconcilerId, campIds },
					host.ctx,
				);
				return outcome(host, "agent accept", format, result, (reconciler) => ({
					code: "HOBO_CD_AGENT_ACCEPTED",
					summary: `agent ${id} accepted for ${campIds.join(", ")}`,
					data: { reconciler },
				}));
			},
		},
		"agent run": {
			usage:
				"hobo deploy agent run --feed <https://station/v1/cd/> --reconciler <id> --key-file <private.jwk.json> --camp <a,b>",
			summary:
				"Run this process as an agent-mode reconciler (outbound HTTPS only)",
			run: async (host, _args, flags, format) => {
				if (!host.runAgent)
					return moduleRefusal("agent run", format, {
						code: "agent-runtime-unavailable",
						message: "this process has no agent runtime composed",
						remediation:
							"Run `hobo deploy agent run` from the HoBo CLI distribution on the target (R7).",
					});
				const result = await host.runAgent({ flags });
				return outcome(host, "agent run", format, result, (r) => ({
					code: "HOBO_CD_AGENT_STOPPED",
					summary: `agent ${r.reconcilerId} stopped at ${r.stoppedAt}`,
					data: r,
				}));
			},
		},
		"agent revoke": {
			usage: "hobo deploy agent revoke <reconciler-id> --reason <text>",
			summary: "Revoke an agent; refused on its next request",
			run: async (host, args, flags, format) => {
				const usage = CD_DEPLOY_SUBCOMMANDS["agent revoke"]?.usage ?? "";
				const id = need(args[0], "<reconciler-id>", usage);
				const reason = need(text(flags, "reason"), "--reason", usage);
				// SAFETY: see agent approve-key.
				const result = await host.cd.enrollment.revoke(
					id as ReconcilerId,
					reason,
					host.ctx,
				);
				return outcome(host, "agent revoke", format, result, (reconciler) => ({
					code: "HOBO_CD_AGENT_REVOKED",
					summary: `agent ${id} revoked`,
					data: { reconciler },
				}));
			},
		},
		"publisher define": {
			usage:
				"hobo deploy publisher define --file <publisher.json|hobo.delivery.ts>",
			summary: "Trust an OIDC publisher (any CI issuer) for Freight push",
			run: defineFrom(
				"publishers",
				"publisher define",
				"HOBO_CD_PUBLISHER_TRUSTED",
				(h, r) => h.cd.publishers.trust(r, h.ctx),
			),
		},
		metrics: {
			usage: "hobo deploy metrics [--window-ms <ms>] [--camp <a,b>]",
			summary: "DORA four keys, reconcile lag and service health",
			run: async (host, _args, flags, format) => {
				const windowMs = num(flags, "window-ms") ?? 30 * 86_400_000;
				const camps = list(flags, "camp").map(asCamp);
				const dora = await host.cd.telemetry.dora(
					{ windowMs, ...(camps.length > 0 ? { campIds: camps } : undefined) },
					host.ctx,
				);
				const lag: Record<string, number | null> = {};
				for (const campId of camps)
					lag[campId] =
						(await host.cd.telemetry.reconcileLagMs(campId, host.ctx)) ?? null;
				return done(
					host,
					"metrics",
					format,
					"HOBO_CD_METRICS",
					`DORA over ${Math.round(windowMs / 86_400_000)}d`,
					{ dora, reconcileLagMs: lag, health: host.cd.telemetry.health() },
				);
			},
		},
		"campset define": {
			usage:
				"hobo deploy campset define --file <campset.json|hobo.delivery.ts>",
			summary: "Define a Camp set (selector or ids)",
			run: defineFrom(
				"campSets",
				"campset define",
				"HOBO_CD_CAMPSET_DEFINED",
				(h, r) => h.cd.inventory.defineSet(r, h.ctx),
			),
		},
		"campset list": {
			usage: "hobo deploy campset list",
			summary: "List Camp sets",
			run: async (host, _args, _flags, format) => {
				const sets = await host.cd.inventory.sets();
				return done(
					host,
					"campset list",
					format,
					"HOBO_CD_CAMPSET_LIST",
					`${sets.length} camp set(s)`,
					{ campSets: sets },
				);
			},
		},
		"camp list": {
			usage: "hobo deploy camp list [--campset <a,b>]",
			summary: "List Camps with declared topology and observed status",
			run: async (host, _args, flags, format) => {
				const campSets = list(flags, "campset");
				const camps = await host.cd.inventory.list(
					campSets.length > 0 ? { campSets } : undefined,
				);
				return done(
					host,
					"camp list",
					format,
					"HOBO_CD_CAMP_LIST",
					`${camps.length} camp(s)`,
					{ camps },
				);
			},
		},
		"camp show": {
			usage: "hobo deploy camp show <camp>",
			summary:
				"Show a Camp's conditions, claims, taints, binding and compliance",
			run: async (host, args, _flags, format) => {
				const campId = asCamp(
					need(
						args[0],
						"<camp>",
						CD_DEPLOY_SUBCOMMANDS["camp show"]?.usage ?? "",
					),
				);
				const status = await host.cd.inventory.status(campId);
				if (!status)
					return notFound(
						"camp show",
						format,
						"camp",
						campId,
						"hobo deploy camp list",
					);
				return done(
					host,
					"camp show",
					format,
					"HOBO_CD_CAMP",
					`camp ${campId}`,
					{
						status,
						binding: await host.cd.campPolicy.binding(campId),
						desired: await host.cd.desired.current(campId),
						observed: await host.cd.desired.status(campId),
					},
				);
			},
		},
		"camp taint": {
			usage:
				"hobo deploy camp taint <camp> --key <k> --effect no-place|no-run --reason <text> [--value <v>]",
			summary: "Add an operator taint (governed)",
			run: async (host, args, flags, format) => {
				const usage = CD_DEPLOY_SUBCOMMANDS["camp taint"]?.usage ?? "";
				const campId = asCamp(need(args[0], "<camp>", usage));
				const taint = create(TaintRecordSchema, {
					key: need(text(flags, "key"), "--key", usage),
					value: text(flags, "value") ?? "",
					effect: oneOf(text(flags, "effect"), EFFECTS, "--effect", usage),
					source: SignalSource.OPERATOR,
					reason: need(text(flags, "reason"), "--reason", usage),
				});
				const result = await host.cd.inventory.taint(
					{ campId, taint },
					host.ctx,
				);
				return outcome(host, "camp taint", format, result, (status) => ({
					code: "HOBO_CD_CAMP_TAINTED",
					summary: `camp ${campId} tainted ${taint.key}`,
					data: { status },
				}));
			},
		},
		"camp untaint": {
			usage:
				"hobo deploy camp untaint <camp> --key <k> --effect no-place|no-run",
			summary: "Remove a taint (governed)",
			run: async (host, args, flags, format) => {
				const usage = CD_DEPLOY_SUBCOMMANDS["camp untaint"]?.usage ?? "";
				const campId = asCamp(need(args[0], "<camp>", usage));
				const key = need(text(flags, "key"), "--key", usage);
				const effect = oneOf(text(flags, "effect"), EFFECTS, "--effect", usage);
				const result = await host.cd.inventory.untaint(
					{ campId, key, effect },
					host.ctx,
				);
				return outcome(host, "camp untaint", format, result, (status) => ({
					code: "HOBO_CD_CAMP_UNTAINTED",
					summary: `camp ${campId} untainted ${key}`,
					data: { status },
				}));
			},
		},
		"camp manage": {
			usage: "hobo deploy camp manage <camp> --management managed|observe-only",
			summary: "Change a Camp's management mode (governed)",
			run: async (host, args, flags, format) => {
				const usage = CD_DEPLOY_SUBCOMMANDS["camp manage"]?.usage ?? "";
				const campId = asCamp(need(args[0], "<camp>", usage));
				const management = oneOf(
					text(flags, "management"),
					MANAGEMENT,
					"--management",
					usage,
				);
				const result = await host.cd.inventory.manage(
					{ campId, management },
					host.ctx,
				);
				return outcome(host, "camp manage", format, result, (status) => ({
					code: "HOBO_CD_CAMP_MANAGED",
					summary: `camp ${campId} is ${CampManagement[management]}`,
					data: { status },
				}));
			},
		},
		"placement define": {
			usage:
				"hobo deploy placement define --file <placement.json|hobo.delivery.ts>",
			summary: "Define a Placement",
			run: defineFrom(
				"placements",
				"placement define",
				"HOBO_CD_PLACEMENT_DEFINED",
				(h, r) => h.cd.placement.define(r, h.ctx),
			),
		},
		"placement decide": {
			usage:
				"hobo deploy placement decide <placement> --pipeline <p> --node <n> --station <s>",
			summary: "Decide a Placement now (deterministic, recorded)",
			run: async (host, args, flags, format) => {
				const usage = CD_DEPLOY_SUBCOMMANDS["placement decide"]?.usage ?? "";
				const placement = need(args[0], "<placement>", usage);
				const count = num(flags, "count");
				const result = await host.cd.placement.decide(
					{
						placement,
						pipeline: need(text(flags, "pipeline"), "--pipeline", usage),
						node: need(text(flags, "node"), "--node", usage),
						stationId: need(text(flags, "station"), "--station", usage),
						subject: { classifications: [], residency: [] },
						...(count !== undefined ? { count } : undefined),
					},
					host.ctx,
				);
				return outcome(
					host,
					"placement decide",
					format,
					result,
					(decision) => ({
						code: "HOBO_CD_PLACEMENT_DECIDED",
						summary: `placement ${placement} decided`,
						data: { decision },
					}),
				);
			},
		},
		"placement show": {
			usage: "hobo deploy placement show <placement|decision-id>",
			summary: "Show a Placement or one recorded decision",
			run: async (host, args, _flags, format) => {
				const id = need(
					args[0],
					"<placement|decision-id>",
					CD_DEPLOY_SUBCOMMANDS["placement show"]?.usage ?? "",
				);
				const placement = await host.cd.placement.get(id);
				const decision = placement
					? undefined
					: await host.cd.placement.decision(id);
				if (!placement && !decision)
					return notFound(
						"placement show",
						format,
						"placement or decision",
						id,
						"hobo deploy placement define --file <placement.json>",
					);
				return done(
					host,
					"placement show",
					format,
					"HOBO_CD_PLACEMENT",
					`placement ${id}`,
					{ placement, decision },
				);
			},
		},
		"scores report": {
			usage: "hobo deploy scores report --file <score-snapshot.json>",
			summary: "Report a placement score snapshot (authorized, expiring)",
			run: async (host, _args, flags, format) => {
				const usage = CD_DEPLOY_SUBCOMMANDS["scores report"]?.usage ?? "";
				const file = need(text(flags, "file"), "--file", usage);
				const { readFile } = await import("node:fs/promises");
				const { resolve } = await import("node:path");
				const { fromJson } = await import("@bufbuild/protobuf");
				const { ScoreSnapshotRecordSchema } = await import("@hobo/cd");
				let snapshot: ReturnType<
					typeof create<typeof ScoreSnapshotRecordSchema>
				>;
				try {
					snapshot = fromJson(
						ScoreSnapshotRecordSchema,
						JSON.parse(await readFile(resolve(host.cwd, file), "utf8")),
					);
				} catch (error) {
					return moduleRefusal("scores report", format, {
						code: "score-snapshot-invalid",
						message: error instanceof Error ? error.message : String(error),
						remediation:
							"Write a ScoreSnapshotRecord in protobuf JSON form with a valid_until.",
					});
				}
				const result = await host.cd.placement.reportScores(snapshot, host.ctx);
				return outcome(host, "scores report", format, result, (s) => ({
					code: "HOBO_CD_SCORES_REPORTED",
					summary: "score snapshot recorded",
					data: { snapshot: s },
				}));
			},
		},
		"fanout show": {
			usage:
				"hobo deploy fanout show [<fanout-id>] [--pipeline <p> --node <n>]",
			summary: "Show one fan-out, or list them",
			run: async (host, args, flags, format) => {
				const id = args[0];
				if (id) {
					// SAFETY: an opaque fan-out id.
					const fanout = await host.cd.fanout.get(id as FanoutId);
					if (!fanout)
						return notFound(
							"fanout show",
							format,
							"fan-out",
							id,
							"hobo deploy fanout show",
						);
					return done(
						host,
						"fanout show",
						format,
						"HOBO_CD_FANOUT",
						`fan-out ${id}`,
						{ fanout },
					);
				}
				const pipeline = text(flags, "pipeline");
				const node = text(flags, "node");
				const fanouts = await host.cd.fanout.list({
					...(pipeline ? { pipeline } : undefined),
					...(node ? { node } : undefined),
				});
				return done(
					host,
					"fanout show",
					format,
					"HOBO_CD_FANOUT_LIST",
					`${fanouts.length} fan-out(s)`,
					{ fanouts },
				);
			},
		},
		"fanout halt": {
			usage: "hobo deploy fanout halt <fanout-id> --reason <text>",
			summary: "Halt a fan-out (governed)",
			run: async (host, args, flags, format) => {
				const usage = CD_DEPLOY_SUBCOMMANDS["fanout halt"]?.usage ?? "";
				const id = need(args[0], "<fanout-id>", usage);
				const reason = need(text(flags, "reason"), "--reason", usage);
				// SAFETY: see fanout show.
				const result = await host.cd.fanout.halt(
					id as FanoutId,
					reason,
					host.ctx,
				);
				return outcome(host, "fanout halt", format, result, (fanout) => ({
					code: "HOBO_CD_FANOUT_HALTED",
					summary: `fan-out ${id} halted`,
					data: { fanout },
				}));
			},
		},
		"fanout resume": {
			usage: "hobo deploy fanout resume <fanout-id>",
			summary: "Resume a halted fan-out (governed)",
			run: async (host, args, _flags, format) => {
				const id = need(
					args[0],
					"<fanout-id>",
					CD_DEPLOY_SUBCOMMANDS["fanout resume"]?.usage ?? "",
				);
				// SAFETY: see fanout show.
				const result = await host.cd.fanout.resume(id as FanoutId, host.ctx);
				return outcome(host, "fanout resume", format, result, (fanout) => ({
					code: "HOBO_CD_FANOUT_RESUMED",
					summary: `fan-out ${id} resumed`,
					data: { fanout },
				}));
			},
		},
		"fanout rollback": {
			usage: "hobo deploy fanout rollback <fanout-id> --reason <text>",
			summary: "Roll back a fan-out's Camps (governed, per D12)",
			run: async (host, args, flags, format) => {
				const usage = CD_DEPLOY_SUBCOMMANDS["fanout rollback"]?.usage ?? "";
				const id = need(args[0], "<fanout-id>", usage);
				const reason = need(text(flags, "reason"), "--reason", usage);
				// SAFETY: see fanout show.
				const result = await host.cd.fanout.rollback(
					id as FanoutId,
					reason,
					host.ctx,
				);
				return outcome(host, "fanout rollback", format, result, (fanout) => ({
					code: "HOBO_CD_FANOUT_ROLLED_BACK",
					summary: `fan-out ${id} rolling back`,
					data: { fanout },
				}));
			},
		},
		"failover list": {
			usage: "hobo deploy failover list [--camp <camp>] [--limit <n>]",
			summary: "List failovers (proposed, running, refused, completed)",
			run: async (host, _args, flags, format) => {
				const camp = text(flags, "camp");
				const limit = num(flags, "limit");
				const failovers = await host.cd.failover.list({
					...(camp ? { campId: asCamp(camp) } : undefined),
					...(limit !== undefined ? { limit } : undefined),
				});
				return done(
					host,
					"failover list",
					format,
					"HOBO_CD_FAILOVER_LIST",
					`${failovers.length} failover(s)`,
					{ failovers },
				);
			},
		},
		"failover approve": {
			usage: "hobo deploy failover approve <failover-id>",
			summary: "Approve a proposed failover (governed saga)",
			run: async (host, args, _flags, format) => {
				const id = need(
					args[0],
					"<failover-id>",
					CD_DEPLOY_SUBCOMMANDS["failover approve"]?.usage ?? "",
				);
				// SAFETY: an opaque failover id.
				const result = await host.cd.failover.approve(
					id as FailoverId,
					host.ctx,
				);
				return outcome(
					host,
					"failover approve",
					format,
					result,
					(failover) => ({
						code: "HOBO_CD_FAILOVER_APPROVED",
						summary: `failover ${id} approved`,
						data: { failover },
					}),
				);
			},
		},
		rebalance: {
			usage: "hobo deploy rebalance --pipeline <p> --node <n> --reason <text>",
			summary: "Explicit, governed re-placement (no automatic failback)",
			run: async (host, _args, flags, format) => {
				const usage = CD_DEPLOY_SUBCOMMANDS.rebalance?.usage ?? "";
				const pipeline = need(text(flags, "pipeline"), "--pipeline", usage);
				const node = need(text(flags, "node"), "--node", usage);
				const reason = need(text(flags, "reason"), "--reason", usage);
				const result = await host.cd.failover.rebalance(
					{
						pipeline,
						node,
						reason,
						idempotencyKey: idempotencyKey(
							flags,
							"rebalance",
							pipeline,
							node,
							reason,
						),
					},
					host.ctx,
				);
				return outcome(host, "rebalance", format, result, (rebalance) => ({
					code: "HOBO_CD_REBALANCE_REQUESTED",
					summary: `rebalance of ${pipeline}/${node} requested`,
					data: { rebalance },
				}));
			},
		},
		"compliance show": {
			usage: "hobo deploy compliance show <camp>",
			summary:
				"Posture compliance, ownership conflicts and remediations for a Camp",
			run: async (host, args, _flags, format) => {
				const campId = asCamp(
					need(
						args[0],
						"<camp>",
						CD_DEPLOY_SUBCOMMANDS["compliance show"]?.usage ?? "",
					),
				);
				return done(
					host,
					"compliance show",
					format,
					"HOBO_CD_COMPLIANCE",
					`compliance for ${campId}`,
					{
						campId,
						binding: await host.cd.campPolicy.binding(campId),
						compliance: await host.cd.posture.compliance(campId),
						conflicts: await host.cd.posture.conflicts(campId),
						remediations: await host.cd.posture.remediations(campId),
					},
				);
			},
		},
	});

/** The authorized action each mutating subcommand performs (D15), for docs and audits. */
export const CD_DEPLOY_ACTIONS: Readonly<Record<string, CdAction>> =
	Object.freeze({
		"freight record": "freight.record",
		"freight yank": "freight.yank",
		"freight approve": "freight.approve",
		"source define": "source.define",
		"pipeline apply": "pipeline.apply",
		"window define": "window.define",
		"window override": "window.override",
		promote: "promote",
		rollback: "rollback",
		"preview create": "preview.create",
		"agent enroll": "reconciler.enroll",
		"agent approve-key": "reconciler.approve-key",
		"agent accept": "reconciler.accept",
		"agent revoke": "reconciler.revoke",
		"publisher define": "publisher.trust",
		"campset define": "campset.define",
		"camp taint": "camp.taint",
		"camp untaint": "camp.untaint",
		"camp manage": "camp.manage",
		"placement define": "placement.define",
		"scores report": "placement.scores",
		"fanout halt": "fanout.halt",
		"fanout resume": "fanout.resume",
		"fanout rollback": "fanout.rollback",
		"failover approve": "failover.approve",
		rebalance: "rebalance",
	});

/** Every CD subcommand's usage line, in table order (`hobo deploy --help`). */
export function cdDeployUsage(): readonly string[] {
	return Object.values(CD_DEPLOY_SUBCOMMANDS).map((s) => s.usage);
}

/** Resolve `args` to a subcommand: two-word groups first, then one word. */
export function matchCdSubcommand(
	args: readonly string[],
): Readonly<{ name: string; rest: readonly string[] }> | undefined {
	const two = args.length >= 2 ? `${args[0]} ${args[1]}` : undefined;
	if (two && CD_DEPLOY_SUBCOMMANDS[two])
		return { name: two, rest: args.slice(2) };
	const one = args[0];
	if (one && CD_DEPLOY_SUBCOMMANDS[one])
		return { name: one, rest: args.slice(1) };
	return undefined;
}

/** True when `args` names a CD subcommand (or a CD group such as `freight`). */
export function isCdSubcommand(args: readonly string[]): boolean {
	if (matchCdSubcommand(args)) return true;
	const group = args[0];
	return (
		group !== undefined &&
		Object.keys(CD_DEPLOY_SUBCOMMANDS).some((k) => k.startsWith(`${group} `))
	);
}

/** Dispatch one `hobo deploy` CD subcommand against a composed host. */
export async function runCdDeploySubcommand(
	host: CdDeployHost,
	args: readonly string[],
	flags: JsonObject,
): Promise<CommandResult> {
	const format = parseCdFormat(flags);
	const sub = args.join(" ") || "(none)";
	if (!format.ok)
		return cdUsage({
			code: "HOBO_DEPLOY_USAGE",
			subcommand: sub,
			message: `--format must be json or text, got ${format.value}`,
			usage: ["--format json", "--format text"],
		});
	const match = matchCdSubcommand(args);
	if (!match) {
		const group = args[0];
		const usage = cdDeployUsage().filter(
			(u) => !group || u.startsWith(`hobo deploy ${group}`),
		);
		return cdUsage({
			code: "HOBO_DEPLOY_USAGE",
			subcommand: sub,
			message: `unknown subcommand "${sub}"`,
			usage: usage.length > 0 ? usage : cdDeployUsage(),
		});
	}
	const entry = CD_DEPLOY_SUBCOMMANDS[match.name];
	if (!entry)
		return cdUsage({
			code: "HOBO_DEPLOY_USAGE",
			subcommand: sub,
			message: "unknown subcommand",
			usage: cdDeployUsage(),
		});
	try {
		return await entry.run(host, match.rest, flags, format.format);
	} catch (error) {
		if (error instanceof Usage)
			return cdUsage({
				code: "HOBO_DEPLOY_USAGE",
				subcommand: match.name,
				message: error.message,
				usage: [error.usage],
			});
		throw error;
	}
}
