// `createChangeWindows`: the ChangeWindows port (D10). Commands append
// `window.Defined` / `window.Overridden` to `cd-window-<name>`; queries read a
// catch-up projection and evaluate purely at the instant the caller passes.
import { clone, create, type JsonValue } from "@bufbuild/protobuf";
import {
	type ChangeWindowRecord,
	ChangeWindowRecordSchema,
	WindowKind,
	type WindowOverrideRecord,
	WindowOverrideRecordSchema,
} from "../_generated/cd_pb.js";
import { CD_DEFAULTS, CD_EVENTS, CD_STREAMS } from "../events.js";
import type {
	CdAction,
	CdAuthorizer,
	CdBase,
	CdContext,
	ChangeWindows,
	Outcome,
	TelemetrySink,
	WindowEvaluation,
} from "../ports.js";
import {
	type ActiveOverride,
	type CompiledWindow,
	compileWindow,
	evaluateWindows,
	parseTimestamp,
} from "./evaluate.js";
import {
	appendOnce,
	body,
	decode,
	digestOf,
	emitCounter,
	principalName,
} from "./journal.js";
import { CatchUpProjection } from "./projection.js";
import { refuse, WINDOW_METRIC, WINDOW_REASON } from "./reasons.js";

export type ChangeWindowsDeps = CdBase & {
	readonly authorizer: CdAuthorizer;
	/** Optional: metrics. Telemetry is advisory; the journal is the record. */
	readonly telemetry?: TelemetrySink | undefined;
};

/** Digest of what a definition says, independent of who defined it. */
export function windowDigest(record: ChangeWindowRecord): string {
	const copy = clone(ChangeWindowRecordSchema, record);
	copy.definedBy = "";
	return digestOf(body(ChangeWindowRecordSchema, copy));
}

const NAME_FROM_STREAM = /^cd-window-(.+)$/;

export function createChangeWindows(deps: ChangeWindowsDeps): ChangeWindows {
	const windows = new Map<string, CompiledWindow>();
	const overrides = new Map<string, WindowOverrideRecord[]>();
	const unreadable = new Set<string>();
	const projection = new CatchUpProjection(deps.store, deps.tenant, {
		[CD_EVENTS.WindowDefined]: (event) => {
			const name = NAME_FROM_STREAM.exec(event.streamId)?.[1] ?? event.streamId;
			const record = decode(ChangeWindowRecordSchema, event.data);
			const compiled = record ? compileWindow(record) : undefined;
			if (compiled?.ok) {
				windows.set(compiled.value.name, compiled.value);
				unreadable.delete(compiled.value.name);
				return;
			}
			unreadable.add(name);
			windows.delete(name);
			emitCounter(deps.telemetry, {
				name: WINDOW_METRIC.unreadable,
				atMs: deps.now(),
				attributes: { tenant: deps.tenant, window: name },
			});
		},
		[CD_EVENTS.WindowOverridden]: (event) => {
			const record = decode(WindowOverrideRecordSchema, event.data);
			if (!record) return;
			const list = overrides.get(record.window) ?? [];
			list.push(record);
			overrides.set(record.window, list);
		},
	});

	const refused = (
		operation: string,
		outcome: Extract<Outcome<never>, { ok: false }>,
		atMs: number,
	) => {
		emitCounter(deps.telemetry, {
			name: WINDOW_METRIC.refused,
			atMs,
			attributes: {
				tenant: deps.tenant,
				operation,
				code: outcome.reasons[0]?.code ?? "",
			},
		});
		return outcome;
	};

	async function govern(
		action: CdAction,
		subject: Readonly<Record<string, JsonValue>>,
		ctx: CdContext,
	): Promise<Outcome<string>> {
		const decision = await deps.authorizer.authorize(
			action,
			{ ...subject },
			ctx,
		);
		if (!decision.ok)
			return {
				ok: false,
				reasons: [
					...refuse(
						WINDOW_REASON.unauthorized,
						`${action} was not authorized`,
						"Ask an operator holding the window permission, or adjust the delivery policy pack.",
						action,
					).reasons,
					...decision.reasons,
				],
			};
		if (decision.value.proposalOnly)
			return refuse(
				WINDOW_REASON.proposalOnly,
				`${principalName(ctx.principal)} may only propose ${action}`,
				"A granted principal must perform this governed action (ADR-0074, ADR-0094).",
				action,
			);
		return { ok: true, value: decision.value.decisionId };
	}

	function activeOverrides(): ActiveOverride[] {
		const out: ActiveOverride[] = [];
		for (const list of overrides.values()) {
			for (const record of list) {
				const expiresAtMs = parseTimestamp(record.expiresAt);
				if (expiresAtMs === undefined) continue;
				out.push({
					window: record.window,
					campIds: record.campIds,
					expiresAtMs,
				});
			}
		}
		return out;
	}

	return {
		async define(window, ctx) {
			const atMs = ctx.now();
			const compiled = compileWindow(window);
			if (!compiled.ok) return refused("define", compiled, atMs);
			const governed = await govern(
				"window.define",
				{ window: window.name, kind: WindowKind[window.kind] ?? "" },
				ctx,
			);
			if (!governed.ok) return refused("define", governed, atMs);
			await projection.catchUp();
			const digest = windowDigest(window);
			const current = windows.get(window.name);
			if (current && windowDigest(current.record) === digest)
				return { ok: true, value: current.record };
			const record = clone(ChangeWindowRecordSchema, window);
			record.definedBy = principalName(ctx.principal);
			const event = await appendOnce({
				store: deps.store,
				streamId: CD_STREAMS.window(window.name),
				type: CD_EVENTS.WindowDefined,
				data: body(ChangeWindowRecordSchema, record),
				idempotencyKey: `window:${digest}`,
				tenant: deps.tenant,
				actor: ctx.principal,
			});
			if (!event)
				return refused(
					"define",
					refuse(
						WINDOW_REASON.conflict,
						`could not append to ${CD_STREAMS.window(window.name)} (concurrent writer or store unavailable)`,
						"Retry the command; it is idempotent.",
						window.name,
					),
					atMs,
				);
			await projection.catchUp();
			emitCounter(deps.telemetry, {
				name: WINDOW_METRIC.defined,
				atMs,
				attributes: {
					tenant: deps.tenant,
					kind: WindowKind[window.kind] ?? "",
				},
			});
			return { ok: true, value: windows.get(window.name)?.record ?? record };
		},

		async list() {
			await projection.catchUp();
			return [...windows.values()]
				.map((window) => window.record)
				.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		},

		async override(input, ctx) {
			const atMs = ctx.now();
			await projection.catchUp();
			const problems: string[] = [];
			if (!windows.has(input.window))
				return refused(
					"override",
					refuse(
						WINDOW_REASON.notFound,
						`no change window named "${input.window}"`,
						"Override an existing window; list them with `hobo deploy windows`.",
						input.window,
					),
					atMs,
				);
			if (input.reason.trim() === "") problems.push("a reason is required");
			const campIds = [...new Set(input.campIds)].sort();
			if (campIds.length === 0 || campIds.some((id) => id === ""))
				problems.push("name the Camps the override lifts the window for");
			const expiresAtMs = parseTimestamp(input.expiresAt);
			if (expiresAtMs === undefined)
				problems.push("expires_at must be an RFC 3339 timestamp");
			else if (expiresAtMs <= atMs)
				problems.push("expires_at must be in the future");
			if (problems.length > 0)
				return refused(
					"override",
					refuse(
						WINDOW_REASON.overrideInvalid,
						problems.join("; "),
						"Give a reason, the Camps, and an expiry within four hours.",
						input.window,
					),
					atMs,
				);
			if (
				expiresAtMs !== undefined &&
				expiresAtMs - atMs > CD_DEFAULTS.windowOverrideMaxMs
			)
				return refused(
					"override",
					refuse(
						WINDOW_REASON.overrideTooLong,
						`an override may last at most ${CD_DEFAULTS.windowOverrideMaxMs / 3_600_000} h`,
						"Shorten the override; grant another when it expires if the work continues.",
						input.window,
					),
					atMs,
				);
			const governed = await govern(
				"window.override",
				{
					window: input.window,
					campIds,
					expiresAt: input.expiresAt,
					reason: input.reason,
				},
				ctx,
			);
			if (!governed.ok) return refused("override", governed, atMs);
			const record = create(WindowOverrideRecordSchema, {
				window: input.window,
				campIds,
				reason: input.reason,
				expiresAt: input.expiresAt,
				decisionId: governed.value,
				grantedBy: principalName(ctx.principal),
			});
			const key = digestOf({
				window: input.window,
				campIds,
				reason: input.reason,
				expiresAt: input.expiresAt,
			});
			const event = await appendOnce({
				store: deps.store,
				streamId: CD_STREAMS.window(input.window),
				type: CD_EVENTS.WindowOverridden,
				data: body(WindowOverrideRecordSchema, record),
				idempotencyKey: `override:${key}`,
				tenant: deps.tenant,
				actor: ctx.principal,
			});
			if (!event)
				return refused(
					"override",
					refuse(
						WINDOW_REASON.conflict,
						`could not append to ${CD_STREAMS.window(input.window)} (concurrent writer or store unavailable)`,
						"Retry the command; it is idempotent.",
						input.window,
					),
					atMs,
				);
			await projection.catchUp();
			emitCounter(deps.telemetry, {
				name: WINDOW_METRIC.overridden,
				atMs,
				attributes: { tenant: deps.tenant, window: input.window },
			});
			return {
				ok: true,
				value: decode(WindowOverrideRecordSchema, event.data) ?? record,
			};
		},

		async evaluate(input): Promise<WindowEvaluation> {
			await projection.catchUp();
			const evaluation = evaluateWindows(windows, activeOverrides(), input, [
				...unreadable,
			]);
			emitCounter(deps.telemetry, {
				name: WINDOW_METRIC.evaluated,
				atMs: input.atMs,
				attributes: {
					tenant: deps.tenant,
					intent: input.intent,
					open: String(evaluation.open),
				},
			});
			return evaluation;
		},
	};
}
