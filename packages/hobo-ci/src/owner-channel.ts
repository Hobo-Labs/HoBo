import type { TrustedVault } from "@hobo/core";

/**
 * How a ceremony reaches the owner when they are not at the machine (a
 * remote dev box run by an agent): a link they open in their own browser,
 * and a secret they hand over through a channel whose value goes only to
 * this process, never to the agent's context, chat, a file or a log (the
 * HoBo MCP App's secret capture, for one).
 */
export interface OwnerChannel {
	/** Show the owner a link for the named capture, and why. */
	openUrl(url: string, message: string, captureName: string): Promise<void>;
	/** Ask for a secret; `undefined` when the owner declined or did not answer. */
	captureSecret(request: {
		readonly name: string;
		readonly title: string;
		readonly instructions: string;
	}): Promise<string | undefined>;
	/** Whether a value the owner handed over is waiting, without taking it. */
	holds(name: string): boolean;
	/**
	 * Show the owner a link now, while the run waits on what they do there (a
	 * device code to approve). Through the HoBo MCP server: the host's own
	 * link prompt, since no progress line reaches them.
	 */
	show?(url: string, message: string, jobKey: string): Promise<void>;
	/**
	 * Ask the owner to do something at a link and say when it is done: one
	 * form, the link in it, answered when they have. `true` once they
	 * confirm; `false` when they declined or the host closed the form;
	 * `undefined` when this host shows no form (the caller falls back).
	 * Through the HoBo MCP server: the host's own form, since the host shows
	 * forms where it may show no link prompt.
	 */
	confirm?(request: {
		readonly url: string;
		readonly message: string;
	}): Promise<boolean | undefined>;
	/**
	 * Work that waits on the owner, run off the request path (a device grant
	 * the owner approves): the call that starts it returns at once, and a
	 * later call reads its state. Only where the channel outlives a call.
	 */
	readonly jobs?: OwnerJobs;
	/**
	 * A trusted vault that outlives a run (the MCP server's memory, never a
	 * file): the store sign-in HoBo created, so the owner signs in once.
	 */
	readonly vault?: TrustedVault;
}

/** The store sign-ins a run may keep in the owner channel's vault. */
export const KEPT_STORE_SIGN_INS = [
	"INFISICAL_TOKEN",
	"OP_SERVICE_ACCOUNT_TOKEN",
	"BWS_ACCESS_TOKEN",
] as const;

/** A job's state, as a later call reads it. */
export type OwnerJobState =
	| {
			readonly state: "pending";
			readonly link: string;
			readonly code: string;
	  }
	| { readonly state: "done" }
	| {
			readonly state: "failed";
			readonly code: string;
			readonly message: string;
	  };

/** How a job ended: it reports this itself, so nothing is thrown past it. */
export type OwnerJobOutcome = Exclude<OwnerJobState, { state: "pending" }>;

export interface OwnerJobs {
	status(key: string): OwnerJobState | undefined;
	/** Start a job only when `key` has no record; return whether it started. */
	start(
		key: string,
		pending: { readonly link: string; readonly code: string },
		job: (signal: AbortSignal) => Promise<OwnerJobOutcome>,
	): boolean;
	/** The job's outcome once it ends (at once when none runs under `key`). */
	outcome(key: string): Promise<OwnerJobState | undefined>;
	/** Drop a finished job's record, so the next call starts afresh. */
	forget(key: string): void;
	/** Every job started so far has ended (for status tools and specs). */
	settled(): Promise<void>;
	/** Abort every running job (the server is closing). */
	close(): void;
}

export function createOwnerJobs(
	options: {
		/** A job ended: the channel can say so (complete the prompt it showed). */
		readonly onSettled?: (
			key: string,
			pending: { readonly link: string; readonly code: string },
			outcome: OwnerJobOutcome,
		) => void;
	} = {},
): OwnerJobs {
	const states = new Map<string, OwnerJobState>();
	const ends = new Map<string, Promise<void>>();
	const running = new Set<Promise<void>>();
	const abort = new AbortController();
	return {
		status: (key) => states.get(key),
		start(key, pending, job) {
			if (states.has(key)) return false;
			states.set(key, { state: "pending", ...pending });
			const settle = (outcome: OwnerJobOutcome) => {
				states.set(key, outcome);
				options.onSettled?.(key, pending, outcome);
			};
			const done = job(abort.signal).then(settle, () =>
				settle({
					state: "failed",
					code: "HOBO_OWNER_JOB_FAILED",
					message: "The background step stopped unexpectedly.",
				}),
			);
			running.add(done);
			ends.set(key, done);
			void done.finally(() => {
				running.delete(done);
				if (ends.get(key) === done) ends.delete(key);
			});
			return true;
		},
		async outcome(key) {
			await ends.get(key);
			return states.get(key);
		},
		forget(key) {
			if (states.get(key)?.state !== "pending") states.delete(key);
		},
		async settled() {
			while (running.size > 0) await Promise.all(running);
		},
		close() {
			abort.abort();
		},
	};
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
