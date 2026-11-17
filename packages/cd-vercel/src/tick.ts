import { QueueClient } from "@vercel/queue";

import { loadCdHost, runCdPass } from "./entry.js";

// The scheduled pass (`api/tick.ts`): Vercel delivers the `hobo-cd-tick`
// schedule to the `hobo-cd` topic (`vercel.json`), and this private queue
// trigger runs one bounded pass: each managed Camp reconciled once under the
// conductor's lease, then one service tick. No public endpoint and no cron
// secret: only Vercel's queue reaches it. The message is a wake-up; its
// content is not read.

const queue = new QueueClient();

/** One pass per delivery; a failure is retried by the queue. */
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
