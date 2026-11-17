/**
 * Where HoBo.CD runs on Vercel: its Yard and Camps (ADR-0157), the other half
 * of the CD Bindle (`packages/hobo-cd/src/bindle.ts`), which names no
 * provider. Mirrors the relay's (`packages/ci-vercel/deploy/yard.ts`).
 *
 * - `cd-api` is a Vercel Function (`api/cd.ts`): `/healthz`, `/readyz` and
 *   the `/v1/cd/` mount (read API, agent delivery feed).
 * - `cd-tick` is a Vercel schedule delivered to the `hobo-cd` queue topic and
 *   consumed by `api/tick.ts`: one bounded pass per delivery. A schedule on a
 *   private queue trigger, not a cron path, so nothing public needs a secret.
 * - `cd-journal` and `cd-config` are in Yards of their own
 *   (`@hobo/hobo-cd` `placement.ts`: the Neon journal fleet, the owner's
 *   config service), joined to this one by `cdJunction`.
 *
 * Like the Bindle, a declaration: nothing in `api/` or `src/` imports it, and
 * `test/cd-yard.test.ts` ties it to `vercel.json` and to the Bindle.
 */
import { camp } from "@hobo/camps";
import { capability } from "@hobo/core";
import { CD_PLACEMENT_YARDS } from "@hobo/hobo-cd";
import { junction } from "@hobo/junctions";
import { project } from "@hobo/provider-vercel";
import { yard } from "@hobo/yards";

/** The Vercel project CD deploys to, and where Vercel builds it from. */
export const CD_PLACEMENT = Object.freeze({
	project: "hobo-cd",
	repository: "Hobo-Labs/HoBo",
	rootDirectory: "packages/cd-vercel",
} as const);

/** The queue topic, the tick schedule and the function entries, by name. */
export const CD_PLATFORM = Object.freeze({
	topic: "hobo-cd",
	schedule: "hobo-cd-tick",
	// The Bindle's cadence (`CD_TICK_SCHEDULE`); `test/cd-yard.test.ts` ties them.
	cron: "* * * * *",
	httpEntry: "api/cd.ts",
	tickEntry: "api/tick.ts",
	maxDuration: 300,
} as const);

const PROJECT = project({ rootDirectory: CD_PLACEMENT.rootDirectory });

const REQUIREMENTS = [
	capability.api.http,
	capability.service.scheduled,
	capability.service.queueConsumer,
	capability.queue.atLeastOnce,
	PROJECT.profile,
];

/** HoBo.CD's own Yard: what Vercel runs. */
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
			properties: { entry: CD_PLATFORM.tickEntry, topic: CD_PLATFORM.topic },
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
	camps: [
		camp("production", { envType: "production", require: REQUIREMENTS }),
		camp("preview", { envType: "preview", require: REQUIREMENTS }),
	],
});

export default CD_YARD;

/** CD's junction: its Vercel Yard joined to the journal and config Yards. */
export const cdJunction = junction("hobo-cd", {
	yards: [CD_YARD, ...CD_PLACEMENT_YARDS],
});
