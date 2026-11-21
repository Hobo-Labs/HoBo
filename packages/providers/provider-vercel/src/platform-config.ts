/**
 * What a plan placed on Vercel asks of the deployment's `vercel.json`.
 *
 * Vercel has no API that creates a schedule or a queue consumer on its own:
 * both are platform configuration a deployment carries (`schedules`, and a
 * function's `experimentalTriggers`), and Vercel's static deployments refuse
 * that file by design. So a schedule or a queue placed on Vercel is executed
 * by a git deployment of a project whose `vercel.json` declares it, and HoBo's
 * part is to hold that file to the plan: `vercelPlatformDrift` lists every
 * difference, and a delivery refuses while there is one.
 *
 * - A schedule with a cadence that runs a queue is a `schedules` entry:
 *   `{ schedule: <cron>, topic: <queue> }`, under the schedule's name.
 * - Every queue has a consumer: some function's `experimentalTriggers`
 *   includes a `queue/v2beta` trigger on its topic.
 * - A schedule on anything but a queue would need a function path to call,
 *   which the plan does not name: it is reported, not guessed.
 */
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "./json.js";

/** The parts of a planned resource this check reads (a `ResourceIntent`). */
export type VercelPlannedResource = Readonly<{
	name: string;
	port: string;
	deps: readonly string[];
	cadence?: string;
}>;

function triggerTopics(config: JsonValue): ReadonlySet<string> {
	const topics = new Set<string>();
	if (!isJsonObject(config) || !isJsonObject(config.functions)) return topics;
	for (const settings of Object.values(config.functions)) {
		if (!isJsonObject(settings) || !isJsonArray(settings.experimentalTriggers))
			continue;
		for (const trigger of settings.experimentalTriggers)
			if (
				isJsonObject(trigger) &&
				trigger.type === "queue/v2beta" &&
				isJsonString(trigger.topic)
			)
				topics.add(trigger.topic);
	}
	return topics;
}

/** Every way `config` differs from what `planned` asks of it; empty when none. */
export function vercelPlatformDrift(
	config: JsonValue,
	planned: readonly VercelPlannedResource[],
): readonly string[] {
	const drift: string[] = [];
	const queues = new Set(
		planned.filter((resource) => resource.port === "queue").map((r) => r.name),
	);
	const consumers = triggerTopics(config);
	for (const queue of [...queues].sort())
		if (!consumers.has(queue))
			drift.push(
				`queue ${queue} has no consumer: no function in vercel.json has a queue/v2beta trigger on topic ${queue}`,
			);
	const schedules =
		isJsonObject(config) && isJsonObject(config.schedules)
			? config.schedules
			: {};
	const plannedSchedules = new Set<string>();
	for (const schedule of planned.filter((r) => r.port === "schedule")) {
		plannedSchedules.add(schedule.name);
		if (schedule.cadence === undefined) {
			drift.push(
				`schedule ${schedule.name} declares no cadence; add the cadence trait`,
			);
			continue;
		}
		const target = schedule.deps.length === 1 ? schedule.deps[0] : undefined;
		if (target === undefined || !queues.has(target)) {
			drift.push(
				`schedule ${schedule.name} must run exactly one queue on Vercel; it runs ${schedule.deps.join(", ") || "nothing"}`,
			);
			continue;
		}
		const entry = schedules[schedule.name];
		if (
			!isJsonObject(entry) ||
			entry.schedule !== schedule.cadence ||
			entry.topic !== target
		)
			drift.push(
				`vercel.json schedules.${schedule.name} must be { "schedule": "${schedule.cadence}", "topic": "${target}" }`,
			);
	}
	for (const name of Object.keys(schedules).sort())
		if (!plannedSchedules.has(name))
			drift.push(
				`vercel.json schedules.${name} is not in the plan; remove it or declare the schedule`,
			);
	return Object.freeze(drift);
}
