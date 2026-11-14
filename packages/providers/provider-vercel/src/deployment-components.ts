/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: this module verifies untrusted deployment configuration JSON at the provider boundary. */
/** Vercel queue and schedule configuration is part of a Git deployment.
 *
 * These helpers check the immutable candidate's configuration. They do not
 * claim that a scheduler has been activated, or that a workload has run.
 */
import { ResolverError } from "@hobo/core";
import { isJsonArray, isJsonObject, type JsonValue } from "./json.js";

export type VercelDeploymentComponent =
	| { readonly kind: "queue"; readonly topic: string; readonly entry: string }
	| {
			readonly kind: "schedule";
			readonly name: string;
			readonly cron: string;
			readonly topic: string;
			readonly entry: string;
			readonly maximumJitterSeconds: number;
	  }
	| {
			readonly kind: "cron";
			readonly path: string;
			readonly cron: string;
			readonly entry: string;
			readonly maximumJitterSeconds: number;
	  }
	| {
			readonly kind: "schedule-function";
			readonly name: string;
			readonly cron: string;
			readonly function: string;
			readonly entry: string;
			readonly maximumJitterSeconds: number;
	  };

export type VercelBillingPlan = "hobby" | "pro" | "enterprise";

function refuse(message: string): never {
	throw new ResolverError("RESOLVER_PRODUCT_UNSUPPORTED", message);
}

/** Parse the numeric five-field cron grammar that Vercel accepts. */
function cronField(input: string, minimum: number, maximum: number): number[] {
	const values = new Set<number>();
	for (const part of input.split(",")) {
		const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/u.exec(part);
		if (!match?.[1]) refuse("Vercel schedule has an invalid cron expression");
		const step = match[2] === undefined ? 1 : Number(match[2]);
		if (!Number.isSafeInteger(step) || step < 1 || step > maximum - minimum + 1)
			refuse("Vercel schedule has an invalid cron step");
		const bounds = match[1].split("-").map(Number);
		const start = match[1] === "*" ? minimum : bounds[0];
		const end =
			match[1] === "*"
				? maximum
				: (bounds[1] ?? (match[2] === undefined ? bounds[0] : maximum));
		if (
			start === undefined ||
			end === undefined ||
			!Number.isInteger(start) ||
			!Number.isInteger(end) ||
			start < minimum ||
			end > maximum ||
			start > end
		)
			refuse("Vercel schedule has an out-of-range cron field");
		for (let n = start; n <= end; n += step) values.add(n);
	}
	return [...values].sort((a, b) => a - b);
}

/** Conservative shortest interval over a day, in minutes. Date restrictions
 * can only increase this interval, so the result never understates frequency. */
export function vercelCronMinimumInterval(expression: string): number {
	const fields = expression.trim().split(/\s+/u);
	if (fields.length !== 5)
		refuse("Vercel schedules require a five-field cron expression");
	const minutes = cronField(fields[0] ?? "", 0, 59);
	const hours = cronField(fields[1] ?? "", 0, 23);
	cronField(fields[2] ?? "", 1, 31);
	cronField(fields[3] ?? "", 1, 12);
	cronField(fields[4] ?? "", 0, 7);
	const times = hours.flatMap((hour) =>
		minutes.map((minute) => hour * 60 + minute),
	);
	if (!times.length) refuse("Vercel schedule has no valid execution times");
	let interval = 1440;
	for (let i = 0; i < times.length; i++) {
		const current = times[i];
		const next = times[(i + 1) % times.length];
		if (current === undefined || next === undefined)
			refuse("Vercel schedule is invalid");
		interval = Math.min(interval, (next - current + 1440) % 1440 || 1440);
	}
	return interval;
}

/** Verify that the exact entry subscribes privately to the expected topic. */
function queueConsumer(config: JsonValue, topic: string, entry: string): void {
	if (!isJsonObject(config) || !isJsonObject(config.functions))
		refuse("Vercel configuration has no queue consumer functions");
	const fn = config.functions[entry];
	if (!isJsonObject(fn) || !isJsonArray(fn.experimentalTriggers))
		refuse("Vercel queue consumer is missing its trigger");
	if (
		fn.experimentalTriggers.length !== 1 ||
		!isJsonObject(fn.experimentalTriggers[0]) ||
		fn.experimentalTriggers[0].type !== "queue/v2beta" ||
		fn.experimentalTriggers[0].topic !== topic
	)
		refuse(
			"Vercel queue consumer does not exclusively subscribe to the expected topic",
		);
}

/** Validate a deployment's authored component against its actual plan. */
export function verifyVercelDeploymentComponent(input: {
	readonly configuration: JsonValue;
	readonly component: VercelDeploymentComponent;
	readonly environment: "production" | "preview";
	readonly plan?: VercelBillingPlan;
}): void {
	const { configuration: config, component } = input;
	if (!isJsonObject(config))
		refuse("Vercel deployment configuration is invalid");
	if (component.kind === "queue") {
		queueConsumer(config, component.topic, component.entry);
		return;
	}
	if (!input.plan)
		refuse("Vercel schedule requires the verified team billing plan");
	if (
		!Number.isSafeInteger(component.maximumJitterSeconds) ||
		component.maximumJitterSeconds < 0
	)
		refuse("Vercel schedule requires an explicit maximum jitter");
	const interval = vercelCronMinimumInterval(component.cron);
	if (component.kind === "cron") {
		if (input.environment !== "production")
			refuse("Vercel Cron Jobs run only in production");
		if (!isJsonArray(config.crons))
			refuse("Vercel deployment has no cron jobs");
		const matches = config.crons.filter(
			(cron) =>
				isJsonObject(cron) &&
				cron.path === component.path &&
				cron.schedule === component.cron,
		);
		if (matches.length !== 1)
			refuse("Vercel cron job is missing or duplicated");
		if (
			isJsonObject(config.schedules) &&
			Object.values(config.schedules).some(
				(entry) =>
					isJsonObject(entry) &&
					entry.path === component.path &&
					entry.schedule === component.cron,
			)
		)
			refuse(
				"Vercel cron and static schedule would invoke the same path twice",
			);
		const outputPath = `/${component.entry.replace(/\.(?:[cm]?js|[cm]?ts)$/u, "")}`;
		const routed =
			component.path === outputPath ||
			(isJsonArray(config.routes) &&
				config.routes.some((route) => {
					if (!isJsonObject(route) || route.dest !== outputPath) return false;
					if (route.src === component.path) return true;
					return (
						route.src === "/(.*)" &&
						isJsonArray(route.transforms) &&
						route.transforms.some(
							(transform) =>
								isJsonObject(transform) &&
								transform.type === "request.path" &&
								transform.op === "set" &&
								transform.args === "/$1",
						)
					);
				}));
		if (!routed)
			refuse("Vercel cron path does not route to the approved function");
		const jitter = input.plan === "hobby" ? 59 * 60 : 60;
		if (input.plan === "hobby" && interval < 1440)
			refuse("Vercel Hobby Cron Jobs cannot run more than once per day");
		if (jitter > component.maximumJitterSeconds)
			refuse(
				"Vercel cron precision does not meet the workload's timing requirement",
			);
		return;
	}
	if (component.kind === "schedule") {
		queueConsumer(config, component.topic, component.entry);
	} else {
		if (!isJsonObject(config.functions))
			refuse("Vercel deployment has no scheduled functions");
		const fn = config.functions[component.entry];
		if (
			!isJsonObject(fn) ||
			!isJsonArray(fn.experimentalTriggers) ||
			fn.experimentalTriggers.length !== 1 ||
			!isJsonObject(fn.experimentalTriggers[0]) ||
			fn.experimentalTriggers[0].type !== "schedule/v1beta"
		)
			refuse("Vercel scheduled function is not private to the scheduler");
		if (
			component.function !==
			component.entry.replace(/\.(?:[cm]?js|[cm]?ts)$/u, "")
		)
			refuse("Vercel schedule function does not match its approved entry");
	}
	if (!isJsonObject(config.schedules))
		refuse("Vercel deployment has no static schedules");
	const schedule = config.schedules[component.name];
	if (
		!isJsonObject(schedule) ||
		schedule.schedule !== component.cron ||
		schedule.path !== undefined ||
		(schedule.timezone !== undefined && schedule.timezone !== "UTC") ||
		(component.kind === "schedule" &&
			(schedule.topic !== component.topic ||
				schedule.function !== undefined)) ||
		(component.kind === "schedule-function" &&
			(schedule.function !== component.function ||
				schedule.topic !== undefined))
	)
		refuse(
			"Vercel static schedule does not match the required target and cadence",
		);
	const jitter =
		schedule.jitter === undefined
			? input.plan === "hobby"
				? 15
				: 1
			: schedule.jitter;
	if (
		typeof jitter !== "number" ||
		!Number.isInteger(jitter) ||
		jitter < 1 ||
		jitter > 15 ||
		(input.plan === "hobby" && jitter !== 15)
	)
		refuse("Vercel static schedule jitter is invalid for the team plan");
	if (interval < jitter || jitter * 60 > component.maximumJitterSeconds)
		refuse(
			"Vercel static schedule frequency or jitter does not meet the workload's timing requirement",
		);
}
