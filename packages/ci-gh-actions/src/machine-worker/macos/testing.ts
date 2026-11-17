/**
 * A fake of Apple's `container` tool for testing `--vm` with no Mac: each
 * `create` is one VM held in memory, and starting the runner in it (the
 * detached start script) calls a runner program the test supplies with the
 * configuration written into the VM over stdin. Nothing here starts a
 * process.
 */
import {
	RUNNER_EXIT_CODE_PATH,
	RUNNER_EXITED_PATH,
} from "../../isolated-worker/container-controller.js";
import type { FakeRunnerProgram } from "../testing.js";
import type { ToolProcess, ToolResult } from "./apple-container.js";

/** One VM the fake made, as a test reads it back. */
export type FakeVm = {
	readonly name: string;
	readonly image: string;
	readonly env: ReadonlyMap<string, string>;
	readonly command: readonly string[];
	started: boolean;
	stopped: boolean;
	deleted: boolean;
	/** What was written into it over stdin, by path. */
	readonly secrets: Map<string, string>;
	exitCode: number | undefined;
	stop: AbortController;
};

/** One command the fake received. */
export type FakeToolCall = Readonly<{
	command: string;
	args: readonly string[];
	stdin: string | undefined;
}>;

const OK: ToolResult = { exitCode: 0, stdout: "", stderr: "" };
const FAILED: ToolResult = { exitCode: 1, stdout: "", stderr: "" };

/** Apple's `container` tool in memory. */
export class FakeAppleContainerTool {
	readonly vms: FakeVm[] = [];
	readonly calls: FakeToolCall[] = [];
	/** Whether `container system status` answers. */
	servicesRunning = true;

	constructor(private readonly program: FakeRunnerProgram) {}

	private vm(id: string | undefined): FakeVm | undefined {
		return this.vms.find((vm) => vm.name === id && !vm.deleted);
	}

	readonly process: ToolProcess = async (command, args, options) => {
		this.calls.push({ command, args: [...args], stdin: options.stdin });
		const [verb, ...rest] = args;
		switch (verb) {
			case "system":
				return this.servicesRunning ? OK : FAILED;
			case "create":
				return this.create(rest);
			case "start": {
				const vm = this.vm(rest[0]);
				if (!vm) return FAILED;
				vm.started = true;
				return OK;
			}
			case "exec":
				return this.exec(rest, options.stdin);
			case "list":
				return {
					...OK,
					stdout: this.vms
						.filter((vm) => vm.started && !vm.stopped && !vm.deleted)
						.map((vm) => `${vm.name}\n`)
						.join(""),
				};
			case "stop": {
				const vm = this.vm(rest[0]);
				if (!vm) return FAILED;
				vm.stopped = true;
				vm.stop.abort();
				return OK;
			}
			case "delete": {
				const vm = this.vm(rest[rest.length - 1]);
				if (!vm) return FAILED;
				vm.deleted = true;
				return OK;
			}
			default:
				return FAILED;
		}
	};

	private create(args: readonly string[]): ToolResult {
		let name: string | undefined;
		const env = new Map<string, string>();
		let at = 0;
		for (; at < args.length; at += 2) {
			const flag = args[at];
			const value = args[at + 1] ?? "";
			if (flag === "--name") name = value;
			else if (flag === "--env") {
				const split = value.indexOf("=");
				env.set(value.slice(0, split), value.slice(split + 1));
			} else break;
		}
		const image = args[at];
		if (name === undefined || image === undefined || this.vm(name))
			return FAILED;
		this.vms.push({
			name,
			image,
			env,
			command: args.slice(at + 1),
			started: false,
			stopped: false,
			deleted: false,
			secrets: new Map(),
			exitCode: undefined,
			stop: new AbortController(),
		});
		return { ...OK, stdout: `${name}\n` };
	}

	private exec(args: readonly string[], stdin: string | undefined): ToolResult {
		const flags = new Set<string>();
		let at = 0;
		while (args[at]?.startsWith("--")) flags.add(args[at++] ?? "");
		const vm = this.vm(args[at]);
		const argv = args.slice(at + 1);
		if (!vm?.started || vm.stopped) return { ...FAILED, exitCode: 125 };
		if (flags.has("--interactive")) {
			const path = argv[argv.length - 1];
			if (path === undefined || stdin === undefined) return FAILED;
			vm.secrets.set(path, stdin);
			return OK;
		}
		if (argv[0] === "test")
			return argv[2] === RUNNER_EXITED_PATH && vm.exitCode !== undefined
				? OK
				: FAILED;
		if (argv[0] === "head")
			return argv[3] === RUNNER_EXIT_CODE_PATH && vm.exitCode !== undefined
				? { ...OK, stdout: `${vm.exitCode}\n` }
				: FAILED;
		if (flags.has("--detach")) {
			const jit = [...vm.secrets.values()][0];
			if (jit === undefined) return FAILED;
			void this.program({
				where: vm.name,
				encodedJitConfig: jit,
				env: vm.env,
				signal: vm.stop.signal,
			})
				.catch(() => 1)
				.then((code) => {
					vm.exitCode = code;
				});
			return OK;
		}
		return OK;
	}
}
