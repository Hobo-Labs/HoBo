/**
 * A runner service over the simulator, behind the wave 0 port
 * (`src/runner-protocol/port.ts`): a session signs in as a registered runner,
 * is offered the jobs GitHub's matching rule gives that runner, and completes
 * them with a HoBo answer. It is the in-process reference the protocol client
 * is compared with; a client that speaks HTTP is mounted at
 * `RUNNER_SERVICE_PATH` instead (`GithubSimulator.mountRunnerService`).
 *
 * `nextJob` does not wait: the simulator's clock moves only when a scenario
 * moves it, so a session with nothing to take gets undefined at once.
 */
import type { RelayJobAnswer, RelayJobMessage } from "@hobo/ci";
import type {
	ParsedJitConfig,
	RunnerServiceClient,
	RunnerSession,
} from "../../../src/runner-protocol/port.js";
import type { SimulatorState } from "./state.js";

/** The path under the simulator's base URL where the runner service lives. */
export const RUNNER_SERVICE_PATH = "/runner-service";

/** What a session is handed: the simulator's state. */
export type RunnerServiceHost = Readonly<{ state: SimulatorState }>;

export class SimulatedRunnerService implements RunnerServiceClient {
	private opened = 0;

	constructor(private readonly host: RunnerServiceHost) {}

	async open(jit: ParsedJitConfig): Promise<RunnerSession> {
		const { state } = this.host;
		const name = jit.runner.agentName;
		const runner = state.runnerByName(name);
		if (!runner)
			throw new Error(`no runner named ${name} is registered with GitHub`);
		runner.sessions += 1;
		runner.status = "online";
		this.opened += 1;
		const session = `${name}#${this.opened}`;
		let closed = false;
		const live = () => {
			if (closed) throw new Error("the runner session is closed");
		};
		return {
			nextJob: async (): Promise<RelayJobMessage | undefined> => {
				live();
				const job = state.claim(name, session);
				return job ? state.relayJobMessage(job) : undefined;
			},
			complete: async (answer: RelayJobAnswer): Promise<void> => {
				live();
				state.completeFromService(session, answer);
			},
			close: async (): Promise<void> => {
				if (closed) return;
				closed = true;
				const current = state.runnerByName(name);
				if (!current) return;
				current.sessions -= 1;
				if (current.sessions === 0) current.status = "offline";
			},
		};
	}
}
