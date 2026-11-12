/**
 * The `github-actions-job` work kind of HoBo Fleet (L16). Signatures frozen by
 * the fleet contract commit (ADR-0182).
 */
import {
	type Clock,
	type FleetLog,
	FleetNotImplemented,
	type Outcome,
	type WorkRunner,
	type WorkSource,
} from "@hobo/fleet";
import type { GithubJobPollerOptions } from "../isolated-worker/github-job-poller.js";

export type GithubWorkOptions = Readonly<{
	/** The existing poller's options, unchanged. */
	poller: GithubJobPollerOptions;
	/** Mints one single-use just-in-time runner registration; the result is the order's sealed secret. */
	mintRegistration(
		input: Readonly<{
			repository: string;
			labels: readonly string[];
			runnerName: string;
		}>,
	): Promise<Outcome<Uint8Array>>;
	now: Clock;
	log: FleetLog;
}>;

/** Polls queued jobs for a fleet's repositories and prepares one registration per claimant. */
export function createGithubActionsWorkSource(
	options: GithubWorkOptions,
): WorkSource {
	void options;
	throw new FleetNotImplemented("createGithubActionsWorkSource");
}

/** Runs one just-in-time runner inside the order's sandbox and fences the job it is handed. */
export function createGithubActionsWorkRunner(): WorkRunner {
	throw new FleetNotImplemented("createGithubActionsWorkRunner");
}
