import type {
	Clock,
	FleetLog,
	Outcome,
	WorkRunner,
	WorkSource,
} from "@hobo/fleet";
import type { GithubJobPollerOptions } from "../isolated-worker/github-job-poller.js";
import { githubActionsRunner } from "./runner.js";
import { githubActionsSource } from "./source.js";

export type GithubWorkOptions = Readonly<{
	poller: GithubJobPollerOptions;
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

export function createGithubActionsWorkSource(
	options: GithubWorkOptions,
): WorkSource {
	return githubActionsSource(options);
}

export function createGithubActionsWorkRunner(): WorkRunner {
	return githubActionsRunner();
}
