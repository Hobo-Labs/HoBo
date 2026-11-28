import { fork } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { create, toJson } from "@bufbuild/protobuf";
import { bindle } from "@hobo/bindles";
import {
	loadBindleDefinition,
	loadProjectManifest,
	parseArgv,
} from "@hobo/cli";
import { manifestHostingPolicy } from "@hobo/cloud";
import fc from "fast-check";
import { expect, it } from "vitest";
import { LocalDeploymentLaunchSchema } from "../src/_generated/composition_pb.js";
import { initBareMetalYard } from "../src/bare-metal-yard.js";
import { resolveBindlePlacement } from "../src/broker-runtime.js";
import { createBrokerAwareUpCommand } from "../src/broker-up-command.js";
import {
	readLocalDeployment,
	startLocalDeployment,
} from "../src/local-deployment.js";
import {
	fingerprintLocalDeployment,
	materializeLocalDeploymentSnapshot,
} from "../src/local-deployment-fingerprint.js";

type ChangePhase = "none" | "ready" | "placement" | "handoff" | "temporary";

async function withProject(
	run: (cwd: string, hoboHome: string) => Promise<void>,
) {
	const cwd = await mkdtemp(join(tmpdir(), "hobo-work-binding-"));
	const hoboHome = join(cwd, "home");
	try {
		await mkdir(join(cwd, "src"));
		await writeFile(
			join(cwd, "src/bindle.mjs"),
			`export default {name:'sample', resources:{web:{name:'web',kind:'web',stableId:'web:web',annotations:[],dependsOn:[],declaredAllow:[]}},edges:[],requirements:{require:[],prefer:[],runtimes:[],labels:{}},entrypoint:()=>undefined};`,
		);
		initBareMetalYard({ hoboHome, componentHost: "local" });
		await run(cwd, hoboHome);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

function request(cwd: string, hoboHome: string) {
	const parsed = parseArgv(["up", "--home", hoboHome], { cwd });
	return {
		context: {
			cwd,
			projectDir: cwd,
			identity: null,
			clients: { readApi: "local", runtime: "local" },
		},
		flags: { ...parsed.flags },
		args: parsed.args,
		verb: "up",
		emitProgress: (_message: string) => {},
	};
}

it("binds the supplied project digest into the placement request", async () => {
	const hoboHome = await mkdtemp(join(tmpdir(), "hobo-work-digest-"));
	try {
		initBareMetalYard({ hoboHome, componentHost: "local" });
		const definition = bindle("digest", (b) => ({ api: b.api() }));
		const digest: `sha256:${string}` = `sha256:${"a".repeat(64)}`;
		const result = await resolveBindlePlacement({
			definition,
			hoboHome,
			providerId: "@hobo/provider-local-host",
			workloadDigest: digest,
		});
		expect(result.outcome).toBe("resolved");
		expect(result.workloadDigest).toBe(digest);
		expect(result.yardPlacement?.localHostingProof).toBeDefined();
		await expect(
			resolveBindlePlacement({
				definition,
				hoboHome,
				workloadDigest: "sha256:bad",
			}),
		).rejects.toThrow("Invalid project input digest");
	} finally {
		await rm(hoboHome, { recursive: true, force: true });
	}
}, 300_000);

it("refuses startup when a budget manifest appears after initial admission", async () => {
	await withProject(async (cwd, hoboHome) => {
		let starts = 0;
		let changed = false;
		const manifest = {
			schema: "hobo.manifest/v1",
			componentHost: { kind: "wasm", version: "1" },
			policy: { budget: { hardLimitUsd: 1 } },
			resources: {
				app: {
					type: "component.v1",
					runtime: "wasm",
					image: "oci://test/app",
					exports: ["wasi:http/incoming-handler"],
				},
			},
		};
		const command = createBrokerAwareUpCommand({
			env: {},
			persistentLocal: true,
			startLocalDeployment: async () => {
				starts++;
				throw new Error("local start reached");
			},
		});
		const input = request(cwd, hoboHome);
		input.emitProgress = (message: string) => {
			if (!message.includes("yard-first placement")) return;
			changed = true;
			writeFileSync(join(cwd, "hobo.bindle.json"), JSON.stringify(manifest));
		};
		const result = await command.run(input);
		const current = await loadProjectManifest(cwd);
		expect(changed).toBe(true);
		expect(current && manifestHostingPolicy(current).required).toBe(true);
		expect(starts).toBe(0);
		expect(result.code).toBe("HOBO_UP_INPUTS_CHANGED");
	});
}, 300_000);

it("refuses inputs changed while the initial Bindle is imported", async () => {
	await withProject(async (cwd, hoboHome) => {
		await writeFile(
			join(cwd, "src/bindle.mjs"),
			`import {writeFileSync} from 'node:fs'; writeFileSync(new URL('../changed.txt',import.meta.url),'changed');
export default {name:'sample', resources:{web:{name:'web',kind:'web',stableId:'web:web',annotations:[],dependsOn:[],declaredAllow:[]}},edges:[],requirements:{require:[],prefer:[],runtimes:[],labels:{}},entrypoint:()=>undefined};`,
		);
		let starts = 0;
		const command = createBrokerAwareUpCommand({
			env: {},
			persistentLocal: true,
			startLocalDeployment: async () => {
				starts++;
				throw new Error("local start reached");
			},
		});
		const result = await command.run(request(cwd, hoboHome));
		expect(result.code).toBe("HOBO_UP_INPUTS_CHANGED");
		expect(starts).toBe(0);
	});
}, 300_000);

it("refuses project changes while the local port is allocated", async () => {
	await withProject(async (cwd, hoboHome) => {
		let starts = 0;
		const command = createBrokerAwareUpCommand({
			env: {},
			persistentLocal: true,
			allocateLocalPort: async () => {
				await writeFile(join(cwd, "workload.txt"), "changed");
				return 12345;
			},
			startLocalDeployment: async () => {
				starts++;
				throw new Error("local start reached");
			},
		});
		const result = await command.run(request(cwd, hoboHome));
		expect(result.code).toBe("HOBO_UP_INPUTS_CHANGED");
		expect(starts).toBe(0);
	});
}, 300_000);

it("refuses a changed project before starting a persistent worker", async () => {
	await withProject(async (cwd, hoboHome) => {
		const expectedContentFingerprint = await fingerprintLocalDeployment(
			cwd,
			hoboHome,
		);
		await writeFile(join(cwd, "workload.txt"), "changed");
		await expect(
			startLocalDeployment({
				projectDir: cwd,
				hoboHome,
				componentHost: "local",
				bindleName: "sample",
				brokerId: "broker:local",
				campId: "camp:local",
				providerId: "@hobo/provider-local-host",
				port: 0,
				ttlSeconds: 0,
				expectedContentFingerprint,
			}),
		).rejects.toThrow("Local project inputs changed before worker startup");
		expect(await readLocalDeployment(cwd)).toBeUndefined();
	});
}, 300_000);

it("retains the approved fingerprint when the caller changes launch options", async () => {
	await withProject(async (cwd, hoboHome) => {
		const approved = await fingerprintLocalDeployment(cwd, hoboHome);
		await writeFile(join(cwd, "workload.txt"), "changed");
		const changed = await fingerprintLocalDeployment(cwd, hoboHome);
		const options = {
			projectDir: cwd,
			hoboHome,
			componentHost: "local",
			bindleName: "sample",
			brokerId: "broker:local",
			campId: "camp:local",
			providerId: "@hobo/provider-local-host",
			port: 0,
			ttlSeconds: 0,
			expectedContentFingerprint: approved,
		};
		const result = startLocalDeployment(options);
		queueMicrotask(() => {
			options.expectedContentFingerprint = changed;
		});
		await expect(result).rejects.toThrow(
			"Local project inputs changed before worker startup",
		);
		expect(await readLocalDeployment(cwd)).toBeUndefined();
	});
}, 300_000);

it("loads changed source through a new content-addressed module path", async () => {
	await withProject(async (cwd, hoboHome) => {
		const source = join(cwd, "src/bindle.mjs");
		await writeFile(
			source,
			`export default {name:'first', resources:{}, edges:[]};`,
		);
		const firstDigest = await fingerprintLocalDeployment(cwd, hoboHome);
		const firstSnapshot = await materializeLocalDeploymentSnapshot(
			cwd,
			hoboHome,
			firstDigest,
		);
		expect((await loadBindleDefinition(firstSnapshot))?.name).toBe("first");
		if (process.platform !== "win32") {
			expect(
				(await stat(join(firstSnapshot, "src/bindle.mjs"))).mode & 0o222,
			).toBe(0);
		}

		await writeFile(
			source,
			`export default {name:'second', resources:{}, edges:[]};`,
		);
		const secondDigest = await fingerprintLocalDeployment(cwd, hoboHome);
		const secondSnapshot = await materializeLocalDeploymentSnapshot(
			cwd,
			hoboHome,
			secondDigest,
		);
		expect(secondSnapshot).not.toBe(firstSnapshot);
		expect((await loadBindleDefinition(secondSnapshot))?.name).toBe("second");
	});
}, 300_000);

it("the persistent worker serves approved snapshot bytes after source changes", async () => {
	await withProject(async (cwd, hoboHome) => {
		await writeFile(
			join(cwd, "src/bindle.mjs"),
			`import {bindle} from ${JSON.stringify(import.meta.resolve("@hobo/bindles"))};
export default bindle('sample', b => ({web: b.web(() => () => new Response('approved'))}));`,
		);
		const contentFingerprint = await fingerprintLocalDeployment(cwd, hoboHome);
		await materializeLocalDeploymentSnapshot(cwd, hoboHome, contentFingerprint);
		await writeFile(
			join(cwd, "src/bindle.mjs"),
			`throw new Error('changed source must not be imported');`,
		);
		const worker = fork(
			fileURLToPath(
				new URL("../src/local-deployment-worker.ts", import.meta.url),
			),
			[],
			{
				cwd,
				stdio: ["ignore", "ignore", "ignore", "ipc"],
				execArgv: ["--import", import.meta.resolve("tsx")],
				env: { ...process.env, HOBO_LOCAL_CONTROL_TOKEN: "fixture-token" },
			},
		);
		const exited = once(worker, "exit").catch(() => undefined);
		try {
			const message = once(worker, "message", {
				signal: AbortSignal.timeout(60_000),
			});
			const launch = create(LocalDeploymentLaunchSchema, {
				projectDir: cwd,
				hoboHome,
				componentHost: "local",
				leaseId: "lease-fixture",
				bindleName: "sample",
				brokerId: "broker:local",
				campId: "camp:local",
				providerId: "@hobo/provider-local-host",
				port: 0,
				ttlSeconds: 0,
				contentFingerprint,
			});
			worker.send({
				type: "start",
				launch: toJson(LocalDeploymentLaunchSchema, launch),
			});
			const [response] = await message;
			expect(response).toMatchObject({
				type: "ready",
				receipt: { contentFingerprint },
			});
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the preceding assertion checks the worker's ready receipt shape.
			const ready = response as {
				readonly receipt: { readonly primaryUrl: string };
			};
			expect(await (await fetch(ready.receipt.primaryUrl)).text()).toBe(
				"approved",
			);
		} finally {
			worker.kill("SIGTERM");
			await exited;
		}
	});
}, 300_000);

it("the persistent worker refuses a corrupted approved snapshot", async () => {
	await withProject(async (cwd, hoboHome) => {
		const contentFingerprint = await fingerprintLocalDeployment(cwd, hoboHome);
		const executionProjectDir = await materializeLocalDeploymentSnapshot(
			cwd,
			hoboHome,
			contentFingerprint,
		);
		const copiedSource = join(executionProjectDir, "src/bindle.mjs");
		await chmod(copiedSource, 0o644);
		await writeFile(copiedSource, `throw new Error('corrupted snapshot');`);
		const worker = fork(
			fileURLToPath(
				new URL("../src/local-deployment-worker.ts", import.meta.url),
			),
			[],
			{
				cwd,
				stdio: ["ignore", "ignore", "ignore", "ipc"],
				execArgv: ["--import", import.meta.resolve("tsx")],
				env: { ...process.env, HOBO_LOCAL_CONTROL_TOKEN: "fixture-token" },
			},
		);
		const exited = once(worker, "exit").catch(() => undefined);
		try {
			const message = once(worker, "message", {
				signal: AbortSignal.timeout(60_000),
			});
			worker.send({
				type: "start",
				launch: toJson(
					LocalDeploymentLaunchSchema,
					create(LocalDeploymentLaunchSchema, {
						projectDir: cwd,
						hoboHome,
						componentHost: "local",
						leaseId: "lease-corrupt",
						bindleName: "sample",
						brokerId: "broker:local",
						campId: "camp:local",
						providerId: "@hobo/provider-local-host",
						port: 0,
						ttlSeconds: 0,
						contentFingerprint,
					}),
				),
			});
			const [response] = await message;
			expect(response).toMatchObject({
				type: "error",
				message: "Approved local deployment snapshot is unavailable",
			});
		} finally {
			worker.kill("SIGTERM");
			await exited;
		}
	});
}, 300_000);

it("refuses observed project changes across local placement", async () => {
	const check = async (phase: ChangePhase) => {
		await withProject(async (cwd, hoboHome) => {
			let starts = 0;
			let ports = 0;
			let changed = false;
			const command = createBrokerAwareUpCommand({
				env: {},
				persistentLocal: true,
				allocateLocalPort: async () => {
					ports++;
					return 12345;
				},
				startLocalDeployment: async () => {
					starts++;
					throw new Error("local start reached");
				},
			});
			const input = request(cwd, hoboHome);
			input.emitProgress = (message: string) => {
				const trigger =
					phase === "ready"
						? "hobo broker-runtime: ready"
						: phase === "placement"
							? "yard-first placement"
							: "hobo up: broker placed";
				if (changed || phase === "none" || !message.includes(trigger)) return;
				changed = true;
				writeFileSync(
					join(cwd, phase === "temporary" ? "editor.tmp" : "workload.txt"),
					"changed",
				);
			};
			const result = await command.run(input);
			if (phase === "none" || phase === "temporary") {
				expect(starts).toBe(1);
				expect(ports).toBe(1);
				expect(result.code).toBe("HOBO_UP_FAILED");
			} else {
				expect(changed).toBe(true);
				expect(starts).toBe(0);
				expect(ports).toBe(0);
				expect(result.code).toBe("HOBO_UP_INPUTS_CHANGED");
			}
		});
	};
	const phases: readonly ChangePhase[] = [
		"none",
		"ready",
		"placement",
		"handoff",
		"temporary",
	];
	for (const phase of phases) await check(phase);
	await fc.assert(fc.asyncProperty(fc.constantFrom(...phases), check), {
		seed: 614533,
		numRuns: 20,
	});
}, 300_000);
