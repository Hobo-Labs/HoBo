import { QueueClient } from "@vercel/queue";

import { loadCdHost, runCdPass } from "./entry.js";

const queue = new QueueClient();

export async function onTick(): Promise<void> {
	const { tick, reconciled } = await runCdPass(loadCdHost);
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

export const consume = queue.handleNodeCallback(onTick);
