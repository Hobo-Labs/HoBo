// Pipeline hooks (D4): RUNBOOK through the existing RunbookExecutor, NOTIFY
// through NotificationPort, SUITE through VerifyPort. Hooks replace any
// imperative step runner; there is no shell escape hatch (R2). This module
// also ships the NotificationPort that speaks the CloudEvents HTTP binding
// (structured mode) to an operator-configured endpoint.
import type { HttpTransport, JsonObject } from "@hobo/core";
import {
	HookKind,
	HookPoint,
	type HookRecord,
	type ReasonRecord,
} from "../_generated/cd_pb.js";
import type {
	CampId,
	CdContext,
	FreightId,
	NotificationPort,
	Outcome,
	RunbookExecutor,
	TelemetrySink,
	VerifyPort,
} from "../ports.js";
import {
	canonicalJson,
	emitMetric,
	iso,
	sha256Hex,
} from "../promotion/journal.js";
import { PROMOTION_METRIC, reason } from "../promotion/reasons.js";

export type HookSubject = Readonly<{
	promotionId: string;
	campId: CampId;
	freightId: FreightId;
	pipeline: string;
	node: string;
}>;

export interface HookRunner {
	/**
	 * Run the hooks declared for `point`, in declaration order. RUNBOOK and
	 * SUITE failures fail the point; NOTIFY is best-effort (recorded, never
	 * fatal). ON_FAILURE never fails: it runs every hook and reports.
	 */
	run(
		input: Readonly<{
			hooks: readonly HookRecord[];
			point: HookPoint;
			subject: HookSubject;
		}>,
		ctx: CdContext,
	): Promise<Outcome<number>>;
}

// public-contract: refusal codes of the hook runner.
export const HOOK_REASON = Object.freeze({
	runbookFailed: "hook-runbook-failed",
	suiteFailed: "hook-suite-failed",
	notifyFailed: "hook-notify-failed",
	unknownKind: "hook-kind-unknown",
} as const);

const POINT_NAME: ReadonlyMap<HookPoint, string> = new Map([
	[HookPoint.BEFORE_APPLY, "before-apply"],
	[HookPoint.AFTER_CONVERGED, "after-converged"],
	[HookPoint.AFTER_QUALIFIED, "after-qualified"],
	[HookPoint.ON_FAILURE, "on-failure"],
]);

export function hookPointName(point: HookPoint): string {
	return POINT_NAME.get(point) ?? "unspecified";
}

export function createHookRunner(
	d: Readonly<{
		runbooks: RunbookExecutor;
		suites: VerifyPort;
		notify: NotificationPort;
		telemetry: TelemetrySink;
	}>,
): HookRunner {
	async function runOne(
		hook: HookRecord,
		point: HookPoint,
		subject: HookSubject,
		ctx: CdContext,
	): Promise<ReasonRecord | undefined> {
		const args: JsonObject = {
			promotionId: subject.promotionId,
			campId: subject.campId,
			freightId: subject.freightId,
			pipeline: subject.pipeline,
			node: subject.node,
			point: hookPointName(point),
		};
		switch (hook.kind) {
			case HookKind.RUNBOOK: {
				const result = await d.runbooks.run({ path: hook.ref, args }, ctx);
				if (result.ok) return undefined;
				return reason(
					HOOK_REASON.runbookFailed,
					`runbook ${hook.ref} failed at ${hookPointName(point)}: ${result.reasons.map((r) => r.message).join("; ")}`,
					"Fix the runbook or the condition it checks; the promotion retries the hook on its next tick.",
					subject.campId,
				);
			}
			case HookKind.SUITE: {
				const result = await d.suites.run(
					{
						suite: hook.ref,
						campId: subject.campId,
						freightId: subject.freightId,
					},
					ctx,
				);
				if (result.ok) return undefined;
				return reason(
					HOOK_REASON.suiteFailed,
					`suite ${hook.ref} failed at ${hookPointName(point)}: ${result.reasons.map((r) => r.message).join("; ")}`,
					"Inspect the suite report; promote Freight that passes it.",
					subject.campId,
				);
			}
			case HookKind.NOTIFY: {
				try {
					await d.notify.notify(
						{
							channel: hook.ref,
							subject: `${subject.promotionId}/${subject.campId}`,
							body: args,
						},
						ctx,
					);
				} catch (error) {
					emitMetric(d.telemetry, {
						name: PROMOTION_METRIC.hookRun,
						atMs: ctx.now(),
						attributes: {
							kind: "notify",
							point: hookPointName(point),
							outcome: "error",
						},
					});
					void error;
				}
				return undefined;
			}
			default:
				return reason(
					HOOK_REASON.unknownKind,
					`hook ${hook.ref} has no kind`,
					"Declare the hook as RUNBOOK, NOTIFY or SUITE in the pipeline.",
					subject.campId,
				);
		}
	}

	return {
		async run({ hooks, point, subject }, ctx) {
			const due = hooks.filter((hook) => hook.point === point);
			const failures: ReasonRecord[] = [];
			for (const hook of due) {
				let failure: ReasonRecord | undefined;
				try {
					failure = await runOne(hook, point, subject, ctx);
				} catch (error) {
					failure = reason(
						hook.kind === HookKind.SUITE
							? HOOK_REASON.suiteFailed
							: HOOK_REASON.runbookFailed,
						`hook ${hook.ref} threw at ${hookPointName(point)}: ${error instanceof Error ? error.message : String(error)}`,
						"Fix the hook target; the promotion retries the hook on its next tick.",
						subject.campId,
					);
				}
				emitMetric(d.telemetry, {
					name: PROMOTION_METRIC.hookRun,
					atMs: ctx.now(),
					attributes: {
						kind: HookKind[hook.kind] ?? "UNSPECIFIED",
						point: hookPointName(point),
						outcome: failure ? "failed" : "ok",
					},
				});
				if (failure) {
					failures.push(failure);
					// Failure hooks all run; forward points stop at the first failure.
					if (point !== HookPoint.ON_FAILURE) break;
				}
			}
			if (point === HookPoint.ON_FAILURE || failures.length === 0)
				return { ok: true, value: due.length };
			return { ok: false, reasons: failures };
		},
	};
}

// public-contract: CloudEvents type of a NOTIFY hook delivery.
export const NOTIFY_EVENT_TYPE =
	"dev.cdeventsx.hobo.promotion.hook.notified" as const;

/**
 * NotificationPort over the CloudEvents HTTP binding (structured mode,
 * `application/cloudevents+json`). The event id is a digest of the content,
 * so a retried delivery is recognisable as the same event downstream.
 */
export function createCloudEventsNotifier(
	d: Readonly<{
		http: HttpTransport;
		/** Endpoint for a channel; a channel without one is refused. */
		endpoint: (channel: string) => string | undefined;
		source: string;
		timeoutMs?: number;
	}>,
): NotificationPort {
	return {
		async notify(input, ctx) {
			const url = d.endpoint(input.channel);
			if (!url)
				throw new Error(`no endpoint configured for channel ${input.channel}`);
			const event = {
				specversion: "1.0",
				id: sha256Hex(
					canonicalJson({
						channel: input.channel,
						subject: input.subject,
						data: input.body,
					}),
				),
				source: d.source,
				type: NOTIFY_EVENT_TYPE,
				subject: input.subject,
				time: iso(ctx.now()),
				datacontenttype: "application/json",
				data: input.body,
			};
			const response = await d.http({
				method: "POST",
				url,
				headers: {
					"content-type": "application/cloudevents+json; charset=utf-8",
				},
				body: JSON.stringify(event),
				timeoutMs: d.timeoutMs ?? 5_000,
				maxResponseBytes: 65_536,
			});
			if (response.status < 200 || response.status >= 300)
				throw new Error(`notification endpoint answered ${response.status}`);
		},
	};
}
