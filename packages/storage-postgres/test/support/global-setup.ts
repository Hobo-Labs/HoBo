import type { TestProject } from "vitest/node";
import { planLane, startLane, systemProbe } from "./postgres-lane.js";

declare module "vitest" {
	export interface ProvidedContext {
		/** Connection string of the live lane, or "" when unavailable. */
		postgresUrl: string;
		/** Lane description, or the reason it is unavailable. */
		postgresLane: string;
	}
}

export default async function setup(project: TestProject) {
	const lane = await startLane(planLane(systemProbe()));
	if (lane.url === undefined) {
		project.provide("postgresUrl", "");
		project.provide("postgresLane", lane.reason);
		process.stderr.write(
			`[@hobo/storage-postgres] live PostgreSQL lane SKIPPED: ${lane.reason}\n`,
		);
		return async () => {};
	}
	project.provide("postgresUrl", lane.url);
	project.provide("postgresLane", lane.description);
	process.stderr.write(
		`[@hobo/storage-postgres] live PostgreSQL lane: ${lane.description}\n`,
	);
	return async () => {
		await lane.stop();
	};
}
