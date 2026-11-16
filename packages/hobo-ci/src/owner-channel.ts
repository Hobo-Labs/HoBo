/**
 * How a ceremony reaches the owner when they are not at the machine (a
 * remote dev box run by an agent): a link they open in their own browser,
 * and a secret they hand over through a channel whose value goes only to
 * this process, never to the agent's context, chat, a file or a log (the
 * HoBo MCP App's secret capture, for one).
 */
export interface OwnerChannel {
	/** Show the owner a link to open on their own device, and why. */
	openUrl(url: string, message: string): Promise<void>;
	/** Ask for a secret; `undefined` when the owner declined or did not answer. */
	captureSecret(request: {
		readonly name: string;
		readonly title: string;
		readonly instructions: string;
	}): Promise<string | undefined>;
	/** Whether a value the owner handed over is waiting, without taking it. */
	holds(name: string): boolean;
}

// public-contract: the prefix of a line asking the owner to hand one value to the waiting run.
export const OWNER_CAPTURE_LINE_PREFIX = "HOBO_OWNER_CAPTURE";

/**
 * The line that asks the owner for one value through the HoBo MCP App's
 * secret capture (handed to the waiting run, never to the agent), with the
 * page where they find it.
 */
export function ownerCaptureLine(name: string, guide: string): string {
	return `${OWNER_CAPTURE_LINE_PREFIX} name=${name} guide=${guide}`;
}

/**
 * Take several values only once the owner has handed over all of them, so a
 * value given early is not spent by a run that still lacks another.
 */
export async function captureAll(
	owner: OwnerChannel,
	requests: readonly {
		readonly name: string;
		readonly title: string;
		readonly instructions: string;
	}[],
): Promise<readonly string[] | undefined> {
	if (!requests.every((request) => owner.holds(request.name))) return undefined;
	const values: string[] = [];
	for (const request of requests) {
		const value = await owner.captureSecret(request);
		if (value === undefined) return undefined;
		values.push(value);
	}
	return values;
}
