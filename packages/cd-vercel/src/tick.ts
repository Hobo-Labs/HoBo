import { QueueClient } from "@vercel/queue";

import { loadCdHost, runCdPass } from "./entry.js";

const queue = new QueueClient();

function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
	let inFlight: Promise<T> | undefined;
	return () => {
		if (inFlight !== undefined) return inFlight;
		const tracked = run().finally(() => {
			if (inFlight === tracked) inFlight = undefined;
		});
		inFlight = tracked;
		return tracked;
	};
}

async function runTick(): Promise<void> {
	const vercelEnv = process.env.VERCEL_ENV;
	if (vercelEnv !== undefined && vercelEnv !== "production") {
		process.stdout.write(
			`${JSON.stringify({
				event: "cd.pass.skipped",
				reason: "non-production",
				vercelEnv,
			})}\n`,
		);
		return;
	}
	const report = await runCdPass(loadCdHost);
	if (report.skipped) {
		process.stdout.write(
			`${JSON.stringify({
				event: "cd.pass.skipped",
				reason: "fleet-pass-lease-held",
			})}\n`,
		);
		return;
	}
	const { tick, reconciled } = report;
	const failed = reconciled.filter((camp) => !camp.ok);
	process.stdout.write(
		`${JSON.stringify({
			event: "cd.pass",
			camps: reconciled.length,
			failed: failed.map((camp) => camp.campId),
			store: tick.store,
		})}\n`,
	);
}

export const onTick = singleFlight(runTick);

export const consume = queue.handleNodeCallback(onTick);
