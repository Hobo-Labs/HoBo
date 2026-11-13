// Fail-closed adapters for ports a host has not configured (WP18, plan 0024).
//
// Composition never invents a capability. An unconfigured runbook executor or
// suite runner refuses with a typed reason; an unconfigured traffic shifter
// offers no capability (so a required canary is refused honestly as
// `progressive-unsupported`, I6) and realizes nothing; an unrouted NOTIFY is
// dropped and counted (NOTIFY is best-effort by D4). Unconfigured fan-out
// pricing quotes nothing and records no Station budget, so the D20 aggregate
// refuses every fan-out before any Camp starts.
import type { RoutingPlanId } from "@hobo/core";
import type { FanoutAggregateDeps } from "../adapters/gatekeeper.js";
import type {
	CampId,
	NotificationPort,
	OtelMetricPoint,
	RunbookExecutor,
	TelemetrySink,
	TrafficShifter,
	VerifyPort,
} from "../ports.js";
import { composeRefusal } from "./errors.js";

// public-contract: metric names the fail-closed adapters emit.
export const FAIL_CLOSED_METRICS = Object.freeze({
	refused: "hobo.cd.compose.unconfigured_refusals",
	notifyDropped: "hobo.cd.compose.notify_dropped",
});

function count(
	sink: TelemetrySink | undefined,
	name: string,
	atMs: number,
	attributes: OtelMetricPoint["attributes"],
): void {
	sink
		?.metrics([
			{ name, kind: "counter", value: 1, unit: "1", atMs, attributes },
		])
		.catch(() => {
			// Telemetry is best-effort; it never changes an outcome.
		});
}

export function unconfiguredRunbooks(
	d: Readonly<{ telemetry?: TelemetrySink }> = {},
): RunbookExecutor {
	const port: RunbookExecutor = {
		async run(input, ctx) {
			count(d.telemetry, FAIL_CLOSED_METRICS.refused, ctx.now(), {
				"hobo.cd.port": "runbooks",
			});
			return composeRefusal(
				"compose-runbook-unconfigured",
				`RUNBOOK ${input.path} cannot run: no executor is composed`,
				input.path,
			);
		},
	};
	return Object.freeze(port);
}

export function unconfiguredSuites(
	d: Readonly<{ telemetry?: TelemetrySink }> = {},
): VerifyPort {
	const port: VerifyPort = {
		async run(input, ctx) {
			count(d.telemetry, FAIL_CLOSED_METRICS.refused, ctx.now(), {
				"hobo.cd.port": "suites",
			});
			return composeRefusal(
				"compose-suite-unconfigured",
				`suite ${input.suite} cannot run for ${input.campId}: no runner is composed`,
				input.suite,
			);
		},
	};
	return Object.freeze(port);
}

export function unroutedNotifications(
	d: Readonly<{ telemetry?: TelemetrySink }> = {},
): NotificationPort {
	const port: NotificationPort = {
		async notify(input, ctx) {
			count(d.telemetry, FAIL_CLOSED_METRICS.notifyDropped, ctx.now(), {
				"hobo.cd.notify.channel": input.channel,
			});
		},
	};
	return Object.freeze(port);
}

/** Offers nothing, realizes nothing, reports no plan. */
export function unconfiguredTraffic(
	d: Readonly<{ telemetry?: TelemetrySink }> = {},
): TrafficShifter {
	const port: TrafficShifter = {
		async offerings(_campId: CampId) {
			return [];
		},
		async shift(input, ctx) {
			count(d.telemetry, FAIL_CLOSED_METRICS.refused, ctx.now(), {
				"hobo.cd.port": "traffic",
			});
			const note = `compose-traffic-unconfigured: no traffic routing is composed for ${input.campId}`;
			return {
				planId: input.plan.planId,
				provider: "other" as const,
				realized: "none" as const,
				notes: [note],
				unmet: [note],
			};
		},
		async status(_campId: CampId, _planId: RoutingPlanId) {
			return null;
		},
	};
	return Object.freeze(port);
}

/**
 * No pricing or Station budget authority is composed: no quote, no budget.
 * The fan-out aggregate gate then refuses `fanout-aggregate-quote-missing`
 * (or `fanout-aggregate-budget-missing`) and the refusal is counted; the
 * aggregate never assumes zero cost.
 */
export function unconfiguredFanoutCost(
	d: Readonly<{ telemetry?: TelemetrySink; now?: () => number }> = {},
): Pick<FanoutAggregateDeps, "quote" | "budget"> {
	const now = d.now ?? Date.now;
	return Object.freeze({
		async quote() {
			count(d.telemetry, FAIL_CLOSED_METRICS.refused, now(), {
				"hobo.cd.port": "fanout-quote",
			});
			return undefined;
		},
		async budget() {
			count(d.telemetry, FAIL_CLOSED_METRICS.refused, now(), {
				"hobo.cd.port": "station-budget",
			});
			return undefined;
		},
	});
}
