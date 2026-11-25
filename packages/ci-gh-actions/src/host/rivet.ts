import * as DomainRivet from "@alchemy.run/domain/Rivet";
import type { PoolHost } from "@alchemy.run/rivet/Host";
import type { JsonValue } from "@hobo/core";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { actor, setup } from "rivetkit";
import { db } from "rivetkit/db";
import {
	type GhLintSandbox,
	GhRelay,
	GhRelayHandlers,
	GhRelayJobId,
	type GhRelayJobId as GhRelayJobIdType,
	GhRepoSlug,
	type GhRepoSlug as GhRepoSlugType,
	GhRunnerLabel,
	type GhRunnerLabel as GhRunnerLabelType,
	type GhRunnerProtocol,
} from "../domain/index.js";
import {
	GhRelayRouteFactsFailClosed,
	type GhRelayRouteFactsService,
} from "./route-facts.js";

export type GhRunnerProtocolService = Layer.Success<
	ReturnType<typeof GhRunnerProtocol.toLayer>
>;

export type GhLintSandboxService = Layer.Success<
	ReturnType<typeof GhLintSandbox.toLayer>
>;

export interface GhRelayRivetHostOptions<
	PoolReq,
	ProtoErr,
	ProtoReq,
	SandboxErr,
	SandboxReq,
> {
	readonly name?: string;
	readonly main: string;
	readonly handler?: string;
	readonly pool: Layer.Layer<PoolHost, never, PoolReq>;
	readonly runnerProtocol: Layer.Layer<
		GhRunnerProtocolService,
		ProtoErr,
		ProtoReq
	>;
	readonly lintSandbox: Layer.Layer<
		GhLintSandboxService,
		SandboxErr,
		SandboxReq
	>;
	readonly routeFacts?: Layer.Layer<GhRelayRouteFactsService>;
}

export function createGhRelayRivetLayer<
	PoolReq,
	ProtoErr,
	ProtoReq,
	SandboxErr,
	SandboxReq,
>(
	options: GhRelayRivetHostOptions<
		PoolReq,
		ProtoErr,
		ProtoReq,
		SandboxErr,
		SandboxReq
	>,
) {
	const rivetPlatform = DomainRivet.layerDurableObjects<PoolReq>({
		name: options.name ?? "GhRelay",
		main: options.main,
		handler: options.handler ?? "default",
		pool: options.pool,
	});
	return GhRelay.layer(GhRelayHandlers).pipe(
		Layer.provide(
			Layer.mergeAll(
				rivetPlatform,
				options.runnerProtocol,
				options.lintSandbox,
				options.routeFacts ?? GhRelayRouteFactsFailClosed,
			),
		),
	);
}

const PickRunnerJobStatus = Schema.Literals([
	"queued",
	"claimed",
	"answered",
	"rescued",
]);
export type GhPickRunnerJobStatus = typeof PickRunnerJobStatus.Type;

const PickRunnerRowSchema = Schema.Struct({
	job_id: Schema.NonEmptyString,
	repository: Schema.NonEmptyString,
	runs_on: Schema.NonEmptyString,
	status: PickRunnerJobStatus,
	node_id: Schema.NullOr(Schema.String),
	chosen_runner: Schema.NullOr(Schema.String),
	queued_at_ms: Schema.Int,
	rescue_at_ms: Schema.Int,
});

const decodePickRunnerRows = Schema.decodeUnknownSync(
	Schema.Array(PickRunnerRowSchema),
);

export interface GhPickRunnerJobRecord {
	readonly jobId: string;
	readonly repository: string;
	readonly runsOn: string;
	readonly status: GhPickRunnerJobStatus;
	readonly nodeId: string | null;
	readonly chosenRunner: string | null;
	readonly queuedAtMs: number;
	readonly rescueAtMs: number;
}

export interface GhPickRunnerEvent {
	readonly action: "queued" | "claimed" | "answered" | "rescued";
	readonly job: GhPickRunnerJobRecord;
}

export interface EnqueuePickRunnerInput {
	readonly jobId: GhRelayJobIdType;
	readonly repository: GhRepoSlugType;
	readonly runsOn: GhRunnerLabelType;
	readonly rescueAfterMs: number;
}

const EnqueuePickRunnerInputSchema = Schema.Struct({
	jobId: GhRelayJobId,
	repository: GhRepoSlug,
	runsOn: GhRunnerLabel,
	rescueAfterMs: Schema.Int,
});

const decodeEnqueuePickRunnerInput = Schema.decodeUnknownSync(
	EnqueuePickRunnerInputSchema,
);

export interface ClaimPickRunnerInput {
	readonly jobId: GhRelayJobId;
	readonly nodeId: string;
}

export interface AnswerPickRunnerInput {
	readonly jobId: GhRelayJobId;
	readonly nodeId: string;
	readonly chosenRunner: GhRunnerLabel;
}

function toRecord(row: typeof PickRunnerRowSchema.Type): GhPickRunnerJobRecord {
	return {
		jobId: row.job_id,
		repository: row.repository,
		runsOn: row.runs_on,
		status: row.status,
		nodeId: row.node_id,
		chosenRunner: row.chosen_runner,
		queuedAtMs: row.queued_at_ms,
		rescueAtMs: row.rescue_at_ms,
	};
}

export interface GhPickRunnerRegistryOptions {
	readonly endpoint?: string;
	readonly token?: string;
	readonly httpHost?: string;
	readonly httpPort?: number;
	readonly startEngine?: boolean;
	readonly noWelcome?: boolean;
	readonly shutdown?: {
		readonly gracePeriodMs?: number;
		readonly disableSignalHandlers?: boolean;
	};
}

export function createGhPickRunnerRegistry(
	options: GhPickRunnerRegistryOptions = {},
) {
	const ghPickRunner = actor({
		db: db({
			onMigrate: async (client) => {
				await client.execute(`
					CREATE TABLE IF NOT EXISTS gh_pick_runner_jobs (
						job_id TEXT PRIMARY KEY,
						repository TEXT NOT NULL,
						runs_on TEXT NOT NULL,
						status TEXT NOT NULL,
						node_id TEXT,
						chosen_runner TEXT,
						queued_at_ms INTEGER NOT NULL,
						rescue_at_ms INTEGER NOT NULL
					)
				`);
			},
		}),
		actions: {
			enqueueJob: async (
				c,
				raw: JsonValue,
			): Promise<GhPickRunnerJobRecord> => {
				const input = decodeEnqueuePickRunnerInput(raw);
				const existingRows = decodePickRunnerRows(
					await c.db.execute(
						"SELECT job_id, repository, runs_on, status, node_id, chosen_runner, queued_at_ms, rescue_at_ms FROM gh_pick_runner_jobs WHERE job_id = ?",
						input.jobId,
					),
				);
				const existing = existingRows[0];
				if (existing !== undefined) return toRecord(existing);

				const nowMs = Date.now();
				const rescueAfterMs = Math.max(10, Math.trunc(input.rescueAfterMs));
				const rescueAtMs = nowMs + rescueAfterMs;
				await c.db.execute(
					`INSERT INTO gh_pick_runner_jobs
						(job_id, repository, runs_on, status, node_id, chosen_runner, queued_at_ms, rescue_at_ms)
					VALUES (?, ?, ?, 'queued', NULL, NULL, ?, ?)`,
					input.jobId,
					input.repository,
					input.runsOn,
					nowMs,
					rescueAtMs,
				);
				const record: GhPickRunnerJobRecord = {
					jobId: input.jobId,
					repository: input.repository,
					runsOn: input.runsOn,
					status: "queued",
					nodeId: null,
					chosenRunner: null,
					queuedAtMs: nowMs,
					rescueAtMs,
				};
				await c.schedule.after(rescueAfterMs, "rescueStaleJob", input.jobId);
				c.broadcast("relayUpdated", { action: "queued", job: record });
				return record;
			},
			claimJob: async (
				c,
				input: ClaimPickRunnerInput,
			): Promise<GhPickRunnerJobRecord | null> => {
				const rows = decodePickRunnerRows(
					await c.db.execute(
						"SELECT job_id, repository, runs_on, status, node_id, chosen_runner, queued_at_ms, rescue_at_ms FROM gh_pick_runner_jobs WHERE job_id = ?",
						input.jobId,
					),
				);
				const existing = rows[0];
				if (existing === undefined) return null;
				if (existing.status !== "queued") return toRecord(existing);

				await c.db.execute(
					"UPDATE gh_pick_runner_jobs SET status = 'claimed', node_id = ? WHERE job_id = ? AND status = 'queued'",
					input.nodeId,
					input.jobId,
				);
				const afterClaim = decodePickRunnerRows(
					await c.db.execute(
						"SELECT job_id, repository, runs_on, status, node_id, chosen_runner, queued_at_ms, rescue_at_ms FROM gh_pick_runner_jobs WHERE job_id = ?",
						input.jobId,
					),
				);
				const row = afterClaim[0];
				if (
					row === undefined ||
					row.status !== "claimed" ||
					row.node_id !== input.nodeId
				) {
					return null;
				}
				const claimed = toRecord(row);
				c.broadcast("relayUpdated", { action: "claimed", job: claimed });
				return claimed;
			},
			answerJob: async (
				c,
				input: AnswerPickRunnerInput,
			): Promise<GhPickRunnerJobRecord | null> => {
				const rows = decodePickRunnerRows(
					await c.db.execute(
						"SELECT job_id, repository, runs_on, status, node_id, chosen_runner, queued_at_ms, rescue_at_ms FROM gh_pick_runner_jobs WHERE job_id = ?",
						input.jobId,
					),
				);
				const existing = rows[0];
				if (existing === undefined) return null;
				if (existing.status === "answered" || existing.status === "rescued") {
					return toRecord(existing);
				}
				if (existing.status !== "claimed") {
					return null;
				}
				if (existing.node_id !== input.nodeId) {
					return null;
				}

				await c.db.execute(
					"UPDATE gh_pick_runner_jobs SET status = 'answered', chosen_runner = ? WHERE job_id = ? AND status = 'claimed' AND node_id = ?",
					input.chosenRunner,
					input.jobId,
					input.nodeId,
				);
				const afterAnswer = decodePickRunnerRows(
					await c.db.execute(
						"SELECT job_id, repository, runs_on, status, node_id, chosen_runner, queued_at_ms, rescue_at_ms FROM gh_pick_runner_jobs WHERE job_id = ?",
						input.jobId,
					),
				);
				const row = afterAnswer[0];
				if (
					row === undefined ||
					row.status !== "answered" ||
					row.node_id !== input.nodeId ||
					row.chosen_runner !== input.chosenRunner
				) {
					return null;
				}
				const answered = toRecord(row);
				c.broadcast("relayUpdated", { action: "answered", job: answered });
				return answered;
			},
			rescueStaleJob: async (
				c,
				jobId: string,
			): Promise<{ readonly rescued: boolean; readonly jobId: string }> => {
				const rows = decodePickRunnerRows(
					await c.db.execute(
						"SELECT job_id, repository, runs_on, status, node_id, chosen_runner, queued_at_ms, rescue_at_ms FROM gh_pick_runner_jobs WHERE job_id = ?",
						jobId,
					),
				);
				const existing = rows[0];
				if (existing === undefined || existing.status !== "queued") {
					return { rescued: false, jobId };
				}
				if (Date.now() < existing.rescue_at_ms) {
					return { rescued: false, jobId };
				}
				await c.db.execute(
					"UPDATE gh_pick_runner_jobs SET status = 'rescued' WHERE job_id = ? AND status = 'queued'",
					jobId,
				);
				const rescuedJob: GhPickRunnerJobRecord = {
					...toRecord(existing),
					status: "rescued",
				};
				c.broadcast("relayUpdated", { action: "rescued", job: rescuedJob });
				return { rescued: true, jobId };
			},
			listJobs: async (c): Promise<readonly GhPickRunnerJobRecord[]> => {
				const rows = decodePickRunnerRows(
					await c.db.execute(
						"SELECT job_id, repository, runs_on, status, node_id, chosen_runner, queued_at_ms, rescue_at_ms FROM gh_pick_runner_jobs ORDER BY queued_at_ms ASC, job_id ASC",
					),
				);
				return rows.map(toRecord);
			},
		},
	});

	return setup({
		use: {
			ghPickRunner,
		},
		...(options.endpoint !== undefined
			? { endpoint: options.endpoint }
			: undefined),
		...(options.token !== undefined ? { token: options.token } : undefined),
		...(options.httpHost !== undefined
			? { httpHost: options.httpHost }
			: undefined),
		...(options.httpPort !== undefined
			? { httpPort: options.httpPort }
			: undefined),
		...(options.startEngine !== undefined
			? { startEngine: options.startEngine }
			: undefined),
		...(options.noWelcome !== undefined
			? { noWelcome: options.noWelcome }
			: undefined),
		...(options.shutdown !== undefined
			? { shutdown: options.shutdown }
			: undefined),
	});
}
