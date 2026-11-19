import { camp } from "@hobo/camps";
import { capability } from "@hobo/core";
import { CD_PLACEMENT_YARDS } from "@hobo/hobo-cd";
import { junction } from "@hobo/junctions";
import { project } from "@hobo/provider-vercel";
import { yard } from "@hobo/yards";

export const CD_PLACEMENT = Object.freeze({
	project: "hobo-cd",
	repository: "Hobo-Labs/HoBo",
	rootDirectory: "packages/cd-vercel",
} as const);

export const CD_PLATFORM = Object.freeze({
	topic: "hobo-cd",
	schedule: "hobo-cd-tick",
	cron: "*/5 * * * *",
	httpEntry: "api/cd.ts",
	tickEntry: "api/tick.ts",
	maxDuration: 300,
	maxConcurrency: 1,
} as const);

const PROJECT = project({ rootDirectory: CD_PLACEMENT.rootDirectory });

const REQUIREMENTS = [
	capability.api.http,
	capability.service.scheduled,
	capability.service.queueConsumer,
	capability.queue.atLeastOnce,
	PROJECT.profile,
];

const CD_YARD = yard("hobo-cd", {
	provider: "vercel",
	regions: ["iad1"],
	properties: {
		project: CD_PLACEMENT.project,
		repository: CD_PLACEMENT.repository,
		rootDirectory: CD_PLACEMENT.rootDirectory,
	},
	bindings: [
		{
			profile: PROJECT.profile,
			...(PROJECT.productId !== undefined
				? { productId: PROJECT.productId }
				: undefined),
			properties: { rootDirectory: CD_PLACEMENT.rootDirectory },
		},
		{
			profile: capability.api.http,
			productId: "vercel.function/v1",
			properties: {
				entry: CD_PLATFORM.httpEntry,
				maxDuration: CD_PLATFORM.maxDuration,
			},
		},
		{
			profile: capability.service.queueConsumer,
			productId: "vercel.function/v1",
			properties: {
				entry: CD_PLATFORM.tickEntry,
				topic: CD_PLATFORM.topic,
				maxConcurrency: CD_PLATFORM.maxConcurrency,
				maxDuration: CD_PLATFORM.maxDuration,
			},
		},
		{
			profile: capability.queue.atLeastOnce,
			productId: "vercel.queues/v1",
			properties: { topics: [CD_PLATFORM.topic] },
		},
		{
			profile: capability.service.scheduled,
			productId: "vercel.schedules/v1",
			properties: {
				name: CD_PLATFORM.schedule,
				cron: CD_PLATFORM.cron,
				topic: CD_PLATFORM.topic,
			},
		},
	],
	camps: [camp("production", { envType: "production", require: REQUIREMENTS })],
});

export default CD_YARD;

export const cdJunction = junction("hobo-cd", {
	yards: [CD_YARD, ...CD_PLACEMENT_YARDS],
});
