import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "./json.js";

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
