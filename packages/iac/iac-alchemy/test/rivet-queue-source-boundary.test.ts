import { Providers } from "@alchemy.run/rivet";
import * as Effect from "effect/Effect";
import { Registry, setup } from "rivetkit";
import { describe, expect, it } from "vitest";
import {
	bindRivetAsyncQueueSource,
	createRivetQueueActor,
	rivetAsyncQueueResource,
} from "../src/rivet-queue.js";

function fixture() {
	const binding = createRivetQueueActor({
		actorName: "jobs",
		now: () => 1,
		authorize: () => true,
	});
	const registry = setup({ use: { jobs: binding.actor }, noWelcome: true });
	const sourceDigest = `sha256:${"a".repeat(64)}`;
	const source = {
		main: "/src/jobs.ts",
		resourceName: "jobs",
		bindleName: "queue-app",
		sourceDigest,
		sourceFence: {
			sourceDigest,
			environmentDigest: `sha256:${"d".repeat(64)}`,
			proofRef: "host:source",
			verify: () => true,
		},
		poolDigest: `sha256:${"b".repeat(64)}`,
		isolationDigest: `sha256:${"c".repeat(64)}`,
		poolHost: {
			deployExternal: () => Effect.void,
			deployCrate: () => Effect.void,
		},
		registry,
		binding,
		verifySource: () => true,
	};
	return { source, binding, registry };
}

describe("Rivet queue source and registry boundary", () => {
	it("accepts the exact actor in a genuine RivetKit registry", () => {
		const f = fixture();
		expect(bindRivetAsyncQueueSource(f.source).binding).toBe(f.binding);
	});

	it("rejects source, verifier, registry and pool proxies without traps", () => {
		const f = fixture();
		let traps = 0;
		const wrap = <T extends object>(input: T): T =>
			new Proxy(input, {
				get() {
					traps++;
					throw new Error("get");
				},
				ownKeys() {
					traps++;
					throw new Error("keys");
				},
				getOwnPropertyDescriptor() {
					traps++;
					throw new Error("descriptor");
				},
			});
		expect(() => bindRivetAsyncQueueSource(wrap(f.source))).toThrow();
		expect(() =>
			bindRivetAsyncQueueSource({
				...f.source,
				verifySource: wrap(f.source.verifySource),
			}),
		).toThrow();
		expect(() =>
			bindRivetAsyncQueueSource({
				...f.source,
				sourceFence: wrap(f.source.sourceFence),
			}),
		).toThrow();
		expect(() =>
			bindRivetAsyncQueueSource({
				...f.source,
				sourceFence: {
					...f.source.sourceFence,
					verify: wrap(f.source.sourceFence.verify),
				},
			}),
		).toThrow();
		expect(() =>
			bindRivetAsyncQueueSource({ ...f.source, registry: wrap(f.registry) }),
		).toThrow();
		expect(() =>
			bindRivetAsyncQueueSource({
				...f.source,
				poolHost: wrap(f.source.poolHost),
			}),
		).toThrow();
		expect(() =>
			bindRivetAsyncQueueSource({
				...f.source,
				poolHost: {
					...f.source.poolHost,
					deployExternal: wrap(f.source.poolHost.deployExternal),
				},
			}),
		).toThrow();
		expect(traps).toBe(0);
	});

	it("rejects source, registry and actor accessors without invoking them", () => {
		for (const field of ["source", "config", "use", "actor"] as const) {
			const f = fixture();
			let reads = 0;
			const deny = () => {
				reads++;
				throw new Error(field);
			};
			if (field === "source")
				Object.defineProperty(f.source, "main", { get: deny });
			if (field === "config")
				Object.defineProperty(f.registry, "config", { get: deny });
			if (field === "use")
				Object.defineProperty(f.registry.config, "use", { get: deny });
			if (field === "actor")
				Object.defineProperty(f.registry.config.use, "jobs", { get: deny });
			expect(() => bindRivetAsyncQueueSource(f.source)).toThrow();
			expect(reads).toBe(0);
		}
	});

	it("rejects pool functions replaced during source verification even when reflection is substituted", () => {
		for (const field of ["deployExternal", "deployCrate"] as const) {
			const { source } = fixture();
			const originalReader = Object.getOwnPropertyDescriptor;
			const originalDescriptor = originalReader(source.poolHost, field);
			let redirectedReads = 0;
			let deployments = 0;
			source.verifySource = () => {
				Object.defineProperty(source.poolHost, field, {
					configurable: true,
					value: () => {
						deployments++;
						return Effect.void;
					},
				});
				Object.getOwnPropertyDescriptor = (target, key) => {
					if (target === source.poolHost && key === field) {
						redirectedReads++;
						return originalDescriptor;
					}
					return originalReader(target, key);
				};
				return true;
			};
			let rejected = false;
			try {
				try {
					rivetAsyncQueueResource(source);
				} catch {
					rejected = true;
				}
			} finally {
				Object.getOwnPropertyDescriptor = originalReader;
			}
			expect(rejected).toBe(true);
			expect(redirectedReads).toBe(0);
			expect(deployments).toBe(0);
		}
	});

	it("rejects pool accessors without reading inherited descriptor values", () => {
		for (const field of ["deployExternal", "deployCrate"] as const) {
			const { source } = fixture();
			const define = Object.defineProperty;
			const existing = Object.getOwnPropertyDescriptor(
				Object.prototype,
				"value",
			);
			const original = source.poolHost[field];
			let accessorReads = 0;
			let inheritedReads = 0;
			source.verifySource = () => {
				define(source.poolHost, field, {
					configurable: true,
					get() {
						accessorReads++;
						return original;
					},
				});
				define(Object.prototype, "value", {
					configurable: true,
					get() {
						inheritedReads++;
						return original;
					},
				});
				return true;
			};
			let rejected = false;
			try {
				try {
					rivetAsyncQueueResource(source);
				} catch {
					rejected = true;
				}
			} finally {
				if (existing) define(Object.prototype, "value", existing);
				else Reflect.deleteProperty(Object.prototype, "value");
			}
			expect(rejected).toBe(true);
			expect(accessorReads).toBe(0);
			expect(inheritedReads).toBe(0);
		}
	});

	it("revalidates the originally captured pool methods when the program runs", async () => {
		for (const field of ["deployExternal", "deployCrate"] as const) {
			const { source } = fixture();
			const originalReader = Object.getOwnPropertyDescriptor;
			const descriptor = originalReader(source.poolHost, field);
			let calls = 0;
			let getterReads = 0;
			let redirectedReads = 0;
			source.verifySource = () => {
				calls++;
				if (calls === 2) {
					Object.defineProperty(source.poolHost, field, {
						configurable: true,
						get() {
							getterReads++;
							throw new Error("pool accessor");
						},
					});
					Object.getOwnPropertyDescriptor = (target, key) => {
						if (target === source.poolHost && key === field) {
							redirectedReads++;
							return descriptor;
						}
						return originalReader(target, key);
					};
				}
				return true;
			};
			const program = rivetAsyncQueueResource(source);
			try {
				await expect(
					Effect.runPromise(
						program.pipe(
							Effect.provideService(Providers, {
								kind: "ProviderCollection",
								get: () => undefined,
								providers: {},
							}),
						),
					),
				).rejects.toThrow(
					"the queue source, artifact and exclusive pool fence could not be verified",
				);
			} finally {
				Object.getOwnPropertyDescriptor = originalReader;
			}
			expect(calls).toBe(2);
			expect(getterReads).toBe(0);
			expect(redirectedReads).toBe(0);
		}
	});

	it("denies async source decisions and observes ordinary Promise rejections", async () => {
		const rejected = fixture();
		let unhandled = 0;
		const onUnhandled = () => {
			unhandled++;
		};
		process.on("unhandledRejection", onUnhandled);
		Object.defineProperty(rejected.source, "verifySource", {
			value: () => Promise.reject(new Error("unavailable")),
		});
		try {
			expect(() => bindRivetAsyncQueueSource(rejected.source)).toThrow();
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(unhandled).toBe(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
		const thenable = fixture();
		let reads = 0;
		const untrusted = {};
		// oxlint-disable-next-line unicorn/no-thenable -- SAFETY: rejection must not inspect this accessor.
		const thenKey = "then";
		Object.defineProperty(untrusted, thenKey, {
			get() {
				reads++;
				throw new Error("untrusted then");
			},
		});
		Object.defineProperty(thenable.source, "verifySource", {
			value: () => untrusted,
		});
		expect(() => bindRivetAsyncQueueSource(thenable.source)).toThrow();
		expect(reads).toBe(0);
		const proxied = fixture();
		Object.defineProperty(proxied.source, "verifySource", {
			value: () =>
				new Proxy(
					{},
					{
						get() {
							reads++;
							throw new Error("untrusted proxy");
						},
					},
				),
		});
		expect(() => bindRivetAsyncQueueSource(proxied.source)).toThrow();
		expect(reads).toBe(0);
	});

	it("rechecks pool and registry after the source-fence verifier", async () => {
		for (const changed of ["pool", "registry"] as const) {
			const { source } = fixture();
			let accessorReads = 0;
			source.sourceFence.verify = () => {
				if (changed === "pool") {
					Object.defineProperty(source.poolHost, "deployExternal", {
						configurable: true,
						get() {
							accessorReads++;
							throw new Error("pool accessor");
						},
					});
				} else {
					const other = fixture();
					Reflect.set(source.registry.config.use, "jobs", other.binding.actor);
				}
				return true;
			};
			const program = rivetAsyncQueueResource(source);
			await expect(
				Effect.runPromise(
					program.pipe(
						Effect.provideService(Providers, {
							kind: "ProviderCollection",
							get: () => undefined,
							providers: {},
						}),
					),
				),
			).rejects.toThrow(
				"the queue source, artifact and exclusive pool fence could not be verified",
			);
			expect(accessorReads).toBe(0);
		}
	});

	it("ignores unknown source fields and rejects forged registries and proxied actor maps", () => {
		const f = fixture();
		let reads = 0;
		Object.defineProperty(f.source, "unused", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("unused");
			},
		});
		expect(bindRivetAsyncQueueSource(f.source).binding).toBe(f.binding);
		const other = fixture();
		Reflect.set(
			other.registry.config,
			"use",
			new Proxy(other.registry.config.use, {
				ownKeys() {
					reads++;
					throw new Error("keys");
				},
			}),
		);
		expect(() => bindRivetAsyncQueueSource(other.source)).toThrow();
		const third = fixture();
		expect(() =>
			bindRivetAsyncQueueSource({
				...third.source,
				registry: Object.create(Registry.prototype),
			}),
		).toThrow();
		expect(reads).toBe(0);
	});
});
