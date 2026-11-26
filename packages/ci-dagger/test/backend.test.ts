import type { ContainerWithExecOpts } from "@dagger.io/dagger";
import { ReturnType as DaggerReturnType, Directory } from "@dagger.io/dagger";
import { executePipeline, parsePipeline } from "@hobo/ci";
import { describe, expect, it } from "vitest";
import pact from "../contracts/execution.pact.json" with { type: "json" };
import {
	createDaggerBackend,
	type DaggerClientPort,
	type DaggerConnection,
	type DaggerContainerPort,
} from "../src/backend.js";

const IMAGE = `example.test/toolchain@sha256:${"a".repeat(64)}`;
class Snapshot extends Directory {
	constructor(readonly files = new Map<string, string>()) {
		super();
	}
}
class Engine {
	readonly calls: string[][] = [];
	readonly observed: {
		cwd: string;
		env: Map<string, string>;
		files: Map<string, string>;
	}[] = [];
	readonly matched = new Set<string>();
	closed = 0;
	stopped = 0;
	malformedArtifact = false;
	wait = false;
	failClose = false;
	stdoutError = false;
	exitError = false;
	exitObserved = false;
	released: (() => void) | undefined;
	readonly client: DaggerClientPort = {
		container: () => new Container(this),
		host: () => ({ directory: () => new Snapshot() }),
	};
	readonly connection: DaggerConnection = {
		client: this.client,
		close: async () => {
			this.closed++;
			if (this.failClose) throw new Error("provider teardown unconfirmed");
		},
		stop: async () => {
			this.stopped++;
			this.released?.();
		},
	};
}
class Container implements DaggerContainerPort {
	private source = new Snapshot();
	private cwd = "/";
	private env = new Map<string, string>();
	private output = { exitCode: 0, stdout: "", stderr: "" };
	private pending: Promise<void> | undefined;
	constructor(private engine: Engine) {}
	private copy(): Container {
		const next = new Container(this.engine);
		next.source = new Snapshot(new Map(this.source.files));
		next.cwd = this.cwd;
		next.env = new Map(this.env);
		return next;
	}
	from(image: string): Container {
		expect(image).toBe(IMAGE);
		return this.copy();
	}
	withDirectory(path: string, source: Directory): Container {
		expect(path).toBe("/workspace");
		if (!(source instanceof Snapshot))
			throw new Error("unexpected source type");
		const next = this.copy();
		next.source = new Snapshot(new Map(source.files));
		return next;
	}
	directory(path: string): Snapshot {
		expect(path).toBe("/workspace");
		return this.source;
	}
	withWorkdir(path: string): Container {
		const next = this.copy();
		next.cwd = path;
		return next;
	}
	withEnvVariable(name: string, value: string): Container {
		const next = this.copy();
		next.env.set(name, value);
		return next;
	}
	withExec(
		argv: string[],
		options?: Pick<ContainerWithExecOpts, "expect">,
	): Container {
		expect(options?.expect).toBe(DaggerReturnType.Any);
		const next = this.copy();
		this.engine.calls.push(argv);
		this.engine.observed.push({
			cwd: next.cwd,
			env: new Map(next.env),
			files: new Map(next.source.files),
		});
		if (argv[0] === "sh") {
			expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
			expect(argv[3]).toBe("hobo-artifact");
			expect(argv[4]).toBe("artifact.bin");
			expect(argv[2]).toContain("realpath -e");
			expect(argv[2]).toContain("wc -c");
			expect(argv[2]).toContain("1048576");
			next.output = {
				exitCode: 0,
				stdout: this.engine.malformedArtifact
					? "@invalid"
					: Buffer.from(
							next.source.files.get("artifact.bin") ?? "",
							"binary",
						).toString("base64"),
				stderr: "",
			};
			return next;
		}
		const interaction = pact.interactions.find(
			(row) =>
				JSON.stringify(row.request.contents.argv) === JSON.stringify(argv),
		);
		if (!interaction)
			throw new Error(`unmatched execution contract: ${JSON.stringify(argv)}`);
		this.engine.matched.add(interaction.description);
		const output = interaction.response[0]?.contents;
		if (!output) throw new Error("missing Pact response");
		next.output = { ...output };
		if (argv[4] === "write") {
			next.source.files.set("artifact.bin", "\0first\xff");
		}
		if (this.engine.wait)
			next.pending = new Promise<void>((resolve) => {
				this.engine.released = resolve;
			});
		return next;
	}
	async exitCode(): Promise<number> {
		if (this.engine.exitError) throw new Error("exit-code query lost response");
		await this.pending;
		this.engine.exitObserved = true;
		return this.output.exitCode;
	}
	async stdout(): Promise<string> {
		if (this.engine.stdoutError) throw new Error("stdout query lost response");
		await this.pending;
		return this.output.stdout;
	}
	async stderr(): Promise<string> {
		await this.pending;
		return this.output.stderr;
	}
}
function pipeline(
	argvs = [
		["write", "first"],
		["read", "second"],
	],
	artifacts = ["artifact.bin"],
	id = "dagger-contract",
	identityOverride?: string,
) {
	return parsePipeline(
		JSON.stringify({
			id,
			accountId: "a",
			timeoutSeconds: 30,
			steps: argvs.map((argv, index) => ({
				id: `step-${index}`,
				argv,
				cwd: index === 0 ? "sub" : ".",
				env:
					index === 0
						? { FIRST: "value", HOBO_CI_EXECUTION_ID: identityOverride ?? id }
						: {},
			})),
			artifactPaths: artifacts,
		}),
	);
}
function backend(engine: Engine) {
	return createDaggerBackend({
		image: IMAGE,
		sourceDirectory: ".",
		connect: async () => engine.connection,
	});
}

describe("Dagger portable pipeline execution", () => {
	it("chains workspace data, isolates step env, returns exact logs and binary artifacts", async () => {
		const engine = new Engine();
		const result = await executePipeline(backend(engine), pipeline());
		expect(result.status).toBe("succeeded");
		expect(result.backend).toBe("dagger");
		expect(result.steps.map((step) => [step.exitCode, step.stdout])).toEqual([
			[0, "written\n"],
			[0, "first\n"],
		]);
		expect(engine.observed[0]).toMatchObject({ cwd: "/workspace/sub" });
		expect(engine.observed[0]?.env.get("FIRST")).toBe("value");
		expect(engine.observed[1]?.env.has("FIRST")).toBe(false);
		expect(engine.observed[1]?.files.get("artifact.bin")).toBe("\0first\xff");
		expect(result.artifacts[0]?.data).toEqual(
			Uint8Array.from(Buffer.from("\0first\xff", "binary")),
		);
		expect(result.artifacts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(engine.closed).toBe(1);
	});
	it("keys command graphs by logical execution identity after user env", async () => {
		const engine = new Engine();
		const first = pipeline(
			[["write", "first"]],
			[],
			"logical-first",
			"spoofed",
		);
		expect((await executePipeline(backend(engine), first)).status).toBe(
			"succeeded",
		);
		expect(
			(
				await executePipeline(
					backend(engine),
					pipeline([["write", "first"]], [], "logical-second"),
				)
			).status,
		).toBe("succeeded");
		expect(engine.observed[0]?.env.get("HOBO_CI_EXECUTION_ID")).toBe(
			"logical-first",
		);
		expect(engine.observed[1]?.env.get("HOBO_CI_EXECUTION_ID")).toBe(
			"logical-second",
		);
	});
	it("shares pending shutdown acknowledgment across repeated close calls", async () => {
		const engine = new Engine();
		let release = () => {};
		const acknowledged = new Promise<void>((done) => {
			release = done;
		});
		const adapter = createDaggerBackend({
			image: IMAGE,
			sourceDirectory: ".",
			connect: async () => ({
				client: engine.client,
				async close() {
					engine.closed++;
					await acknowledged;
				},
			}),
		});
		const session = await adapter.open(
			pipeline(),
			new AbortController().signal,
		);
		const first = session.close("completed");
		const second = session.close("completed");
		expect(first).toBe(second);
		let done = false;
		void second.then(() => {
			done = true;
		});
		await Promise.resolve();
		expect(done).toBe(false);
		release();
		await first;
		expect(engine.closed).toBe(1);
	});
	it("preserves a failed shutdown acknowledgment for later callers", async () => {
		const engine = new Engine();
		engine.failClose = true;
		const session = await backend(engine).open(
			pipeline(),
			new AbortController().signal,
		);
		const first = session.close("completed");
		const second = session.close("completed");
		expect(first).toBe(second);
		await expect(first).rejects.toThrow(/unconfirmed/);
		await expect(session.close("cancelled")).rejects.toThrow(/unconfirmed/);
		expect(engine.closed).toBe(1);
	});

	it("retains uncertainty when one SDK read rejects while sibling queries still run", async () => {
		const engine = new Engine();
		engine.wait = true;
		engine.stdoutError = true;
		const adapter = createDaggerBackend({
			image: IMAGE,
			sourceDirectory: ".",
			connect: async () => ({
				client: engine.client,
				close: async () => {
					engine.closed++;
				},
			}),
		});
		const result = await executePipeline(
			adapter,
			pipeline([["write", "first"]], []),
			{ cleanupTimeoutMs: 50 },
		);
		expect(result.status).toBe("uncertain");
		expect(engine.closed).toBe(1);
		expect(engine.exitObserved).toBe(false);
		engine.released?.();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(engine.exitObserved).toBe(true);
	});
	it("uses positive provider stop acknowledgment after a partial SDK query failure", async () => {
		const engine = new Engine();
		engine.wait = true;
		engine.stdoutError = true;
		const result = await executePipeline(
			backend(engine),
			pipeline([["write", "first"]], []),
		);
		expect(result.status).toBe("failed");
		expect(engine.stopped).toBe(1);
		expect(engine.closed).toBe(1);
		expect(engine.exitObserved).toBe(true);
	});
	it("does not treat a settled but rejected exit query as confirmed remote shutdown", async () => {
		const engine = new Engine();
		engine.exitError = true;
		const adapter = createDaggerBackend({
			image: IMAGE,
			sourceDirectory: ".",
			connect: async () => ({
				client: engine.client,
				close: async () => {
					engine.closed++;
				},
			}),
		});
		const result = await executePipeline(
			adapter,
			pipeline([["write", "first"]], []),
		);
		expect(result.status).toBe("uncertain");
		expect(engine.closed).toBe(1);
		expect(engine.exitObserved).toBe(false);
	});

	it("preserves failure exit status and does not execute later steps", async () => {
		const engine = new Engine();
		const result = await executePipeline(
			backend(engine),
			pipeline([["fail"], ["write", "first"]], []),
		);
		expect(result.status).toBe("failed");
		expect(result.steps).toHaveLength(1);
		expect(result.steps[0]).toMatchObject({
			exitCode: 23,
			stdout: "partial\n",
			stderr: "failure\n",
		});
		expect(engine.calls).toHaveLength(1);
		expect(engine.closed).toBe(1);
	});
	it("runs every declared command contract interaction", async () => {
		const engine = new Engine();
		await executePipeline(backend(engine), pipeline());
		await executePipeline(backend(engine), pipeline([["fail"]], []));
		expect(engine.matched.size).toBe(pact.interactions.length);
	});
	it("rejects malformed artifact encoding instead of returning corrupt data", async () => {
		const engine = new Engine();
		engine.malformedArtifact = true;
		const result = await executePipeline(backend(engine), pipeline());
		expect(result.status).toBe("failed");
		expect(result.artifacts).toHaveLength(0);
		expect(engine.closed).toBe(1);
	});
	it("awaits provider stop acknowledgment before reporting cancellation", async () => {
		const engine = new Engine();
		engine.wait = true;
		const controller = new AbortController();
		const result = executePipeline(
			backend(engine),
			pipeline([["write", "first"]], []),
			{ signal: controller.signal },
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		controller.abort();
		expect((await result).status).toBe("cancelled");
		expect(engine.stopped).toBe(1);
		expect(engine.closed).toBe(1);
	});
	it("reports uncertainty when teardown cannot confirm shutdown", async () => {
		const engine = new Engine();
		engine.failClose = true;
		expect(
			(
				await executePipeline(
					backend(engine),
					pipeline([["write", "first"]], []),
				)
			).status,
		).toBe("uncertain");
	});
	it("does not claim cancellation if the SDK connection cannot stop an in-flight command", async () => {
		const engine = new Engine();
		engine.wait = true;
		const controller = new AbortController();
		const adapter = createDaggerBackend({
			image: IMAGE,
			sourceDirectory: ".",
			connect: async () => ({
				client: engine.client,
				close: async () => {
					engine.closed++;
				},
			}),
		});
		const result = executePipeline(
			adapter,
			pipeline([["write", "first"]], []),
			{ signal: controller.signal },
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		controller.abort();
		expect((await result).status).toBe("uncertain");
		expect(engine.closed).toBe(1);
		engine.released?.();
	});
	it("rejects unpinned toolchain images before engine allocation", () => {
		expect(() =>
			createDaggerBackend({ sourceDirectory: ".", image: "ubuntu:latest" }),
		).toThrow(/digest-pinned/);
	});
});
