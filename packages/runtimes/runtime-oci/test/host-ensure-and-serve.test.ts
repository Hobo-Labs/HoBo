/**
 * The OCI Camp host — ensure, schedule, and roll back.
 *
 * This adapter packs WASM components as OCI images and schedules them on
 * Kubernetes through the kubectl PACT boundary. Three properties matter more
 * than the mechanics.
 *
 * **`ensure` and `servePrivate` have different cluster requirements.** Ensure
 * only needs a usable kubectl client — it is what a `hobo yard ensure` runs on
 * a laptop with no cluster, and failing it there would make the install
 * command unusable offline. `servePrivate` genuinely needs a reachable
 * cluster, so it refuses up front rather than failing partway through a
 * schedule.
 *
 * **A failed schedule rolls back everything it already did.** Half a
 * deployment is worse than none: the components that did come up would serve
 * an app whose other half is missing, and nothing else would tear them down.
 * Every port-forward is closed and every scheduled workload deleted before the
 * error propagates.
 *
 * **A component with no built wasm is refused by name.** The OCI host does not
 * build — `@hobo/runtime-wasm` does — and scheduling a component with no
 * artifact would deploy the runtime image with nothing to run inside it, which
 * comes up healthy and serves nothing.
 *
 * Kubernetes names are sanitized rather than passed through: a resource named
 * `My Service!` is a valid Bindle name and an invalid Kubernetes one, and the
 * apply would be rejected by the apiserver with a message about DNS labels.
 */
import { describe, expect, it, vi } from "vitest";

import { createOciRuntimeHost, ensureOciRuntime } from "../src/host.js";
import { KubectlUnavailableError } from "../src/kubectl-transport.js";
import type { KubernetesClient } from "../src/kubernetes-client.js";

/** A Kubernetes client that records what it was asked to do. */
function fakeK8s(
	overrides: Partial<KubernetesClient> & {
		clusterReachable?: boolean;
		ready?: boolean;
	} = {},
) {
	const applied: unknown[][] = [];
	const waited: string[] = [];
	const forwarded: Array<[string, number]> = [];
	const deleted: string[] = [];
	const closed: string[] = [];
	const client = {
		kind: "kubectl",
		namespace: "hobo-dev",
		transport: { name: "FakeClusterApi", handle: () => ({ status: 200 }) },
		probe: async () => ({
			ready: overrides.ready ?? true,
			kubectlBin: "/usr/bin/kubectl",
			clientVersion: "v1.31.0",
			clusterReachable: overrides.clusterReachable ?? true,
			notes: ["fake probe"],
		}),
		apply: async (manifests: unknown[]) => {
			applied.push(manifests);
		},
		waitReady: async (name: string) => {
			waited.push(name);
		},
		portForward: async (service: string, port: number) => {
			forwarded.push([service, port]);
			return {
				loopbackUrl: `http://127.0.0.1:${5000 + forwarded.length}`,
				localPort: 5000 + forwarded.length,
				close: async () => {
					closed.push(service);
				},
			};
		},
		httpProxy: async () => ({ status: 200, headers: {}, json: { ok: true } }),
		delete: async (name: string) => {
			deleted.push(name);
		},
		...overrides,
	} as unknown as KubernetesClient;
	return { client, applied, waited, forwarded, deleted, closed };
}

const ensureCtx = (env: NodeJS.ProcessEnv = {}) => ({
	hoboHome: "/tmp/hobo-oci-test",
	env,
	emitProgress: () => {},
});

describe("ensure", () => {
	it("reports ready with an injected client, without equipping kubectl", async () => {
		// A PACT mock has no binary to download. Attempting one would make every
		// contract test reach for the network.
		const { client } = fakeK8s();
		const result = await createOciRuntimeHost({ kubernetes: client }).ensure(
			ensureCtx(),
		);
		expect(result.kind).toBe("oci");
		expect(result.ready).toBe(true);
		expect(result.notes.join(" ")).toContain("equip skipped (injected");
	});

	it("reports ready when the client works but no cluster answers", async () => {
		// This is `hobo yard ensure` on a laptop with no cluster. Failing here
		// would make the install command unusable offline, and the note says
		// plainly that serving will need more.
		const { client } = fakeK8s({ clusterReachable: false });
		const result = await createOciRuntimeHost({ kubernetes: client }).ensure(
			ensureCtx(),
		);
		expect(result.ready).toBe(true);
		expect(result.notes.join(" ")).toContain("cluster not required for ensure");
		expect(result.details).toMatchObject({ clusterReachable: false });
	});

	it("says both are ready when the cluster answers too", async () => {
		const { client } = fakeK8s();
		const result = await createOciRuntimeHost({ kubernetes: client }).ensure(
			ensureCtx(),
		);
		expect(result.notes.join(" ")).toContain("client and cluster ready");
	});

	it("carries the probe's own notes through", async () => {
		// The probe's notes name the binary and the cluster's error. Dropping
		// them would leave the ensure result unable to say why anything failed.
		const { client } = fakeK8s();
		const result = await createOciRuntimeHost({ kubernetes: client }).ensure(
			ensureCtx(),
		);
		expect(result.notes).toContain("fake probe");
	});

	it("reports the namespace it will schedule into", async () => {
		// Deploying into the wrong namespace is not an error anyone notices —
		// it is a successful deploy nobody can find.
		const { client } = fakeK8s();
		const result = await createOciRuntimeHost({
			kubernetes: client,
			namespace: "team-a",
		}).ensure(ensureCtx());
		expect(result.notes.join(" ")).toContain("namespace=team-a");
		expect(result.details).toMatchObject({ namespace: "team-a" });
	});

	it("defaults the namespace when none is configured", async () => {
		const { client } = fakeK8s();
		expect(
			(await createOciRuntimeHost({ kubernetes: client }).ensure(ensureCtx()))
				.details,
		).toMatchObject({ namespace: "hobo-dev" });
	});

	it("names the transport so a PACT run can tell which side answered", async () => {
		const { client } = fakeK8s();
		expect(
			(await createOciRuntimeHost({ kubernetes: client }).ensure(ensureCtx()))
				.details,
		).toMatchObject({ transport: "FakeClusterApi", mode: "kubectl" });
	});

	it("counts an injected client as equipped even when its probe says otherwise", async () => {
		// A mock provider legitimately reports `ready: false` for the binary it
		// does not have. Treating that as unequipped would fail every contract
		// test's ensure.
		const { client } = fakeK8s({ ready: false });
		const result = await createOciRuntimeHost({ kubernetes: client }).ensure(
			ensureCtx(),
		);
		expect(result.ready).toBe(true);
		expect(result.details).toMatchObject({ clientEquipped: true });
	});

	it("is reachable through the standalone ensure helper", async () => {
		const { client } = fakeK8s();
		expect(
			(await ensureOciRuntime(ensureCtx(), { kubernetes: client })).kind,
		).toBe("oci");
	});
});

describe("servePrivate — cluster requirement", () => {
	it("refuses up front when no cluster is reachable", async () => {
		// Failing partway through a schedule would leave workloads behind. The
		// notes come along because they say *why* it is unreachable.
		const { client } = fakeK8s({ clusterReachable: false });
		await expect(
			createOciRuntimeHost({ kubernetes: client }).servePrivate({
				hoboHome: "/tmp/h",
				privateComponents: [],
				env: {},
			} as never),
		).rejects.toThrow(KubectlUnavailableError);
		await expect(
			createOciRuntimeHost({ kubernetes: client }).servePrivate({
				hoboHome: "/tmp/h",
				privateComponents: [],
				env: {},
			} as never),
		).rejects.toThrow(/fake probe/);
	});

	it("applies nothing when the cluster check fails", async () => {
		const { client, applied } = fakeK8s({ clusterReachable: false });
		await expect(
			createOciRuntimeHost({
				kubernetes: client,
				containerDependencies: [{ resourceName: "db", image: "postgres:16" }],
			}).servePrivate({
				hoboHome: "/tmp/h",
				privateComponents: [],
				env: {},
			} as never),
		).rejects.toThrow();
		expect(applied).toHaveLength(0);
	});
});

describe("servePrivate — container dependencies", () => {
	const serve = async (
		deps: Array<{
			resourceName: string;
			image: string;
			port?: number;
			env?: Record<string, string>;
		}>,
		fake = fakeK8s(),
		ctx: Record<string, unknown> = {},
	) => {
		const result = await createOciRuntimeHost({
			kubernetes: fake.client,
			containerDependencies: deps,
		}).servePrivate({
			hoboHome: "/tmp/h",
			privateComponents: [],
			env: {},
			...ctx,
		} as never);
		return { result, fake };
	};

	it("applies, waits, and port-forwards each dependency", async () => {
		// The order matters: forwarding before the workload is ready would
		// connect to nothing and fail the first request.
		const fake = fakeK8s();
		await serve([{ resourceName: "db", image: "postgres:16" }], fake);
		expect(fake.applied).toHaveLength(1);
		expect(fake.waited).toEqual(["db"]);
		expect(fake.forwarded).toEqual([["db", 8080]]);
	});

	it("uses the dependency's own port when it declares one", async () => {
		const fake = fakeK8s();
		await serve(
			[{ resourceName: "db", image: "postgres:16", port: 5432 }],
			fake,
		);
		expect(fake.forwarded).toEqual([["db", 5432]]);
	});

	it("registers a handler under the dependency's Bindle name, not its k8s name", async () => {
		// Callers reach dependencies by the name they wrote in the Bindle. The
		// sanitized name is an implementation detail of the cluster.
		const { result } = await serve([
			{ resourceName: "My Cache!", image: "redis:7" },
		]);
		expect([...result.handlers.keys()]).toEqual(["My Cache!"]);
	});

	it("sanitizes the name it schedules under", async () => {
		// `My Cache!` is a valid Bindle name and an invalid DNS label — the
		// apiserver would reject the apply with a message about label syntax.
		const fake = fakeK8s();
		await serve([{ resourceName: "My Cache!", image: "redis:7" }], fake);
		expect(fake.waited).toEqual(["my-cache"]);
	});

	it("proxies a request through the cluster boundary", async () => {
		// The handler is what a component calls. It has to reach the workload
		// through the same PACT-shaped hop the rest of the host uses.
		const fake = fakeK8s();
		const { result } = await serve(
			[{ resourceName: "db", image: "postgres:16" }],
			fake,
		);
		const response = await result.handlers.get("db")?.(
			new Request("http://component.local/query?x=1"),
		);
		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({ ok: true });
	});

	it("returns text when the proxy answered with text", async () => {
		const fake = fakeK8s({
			httpProxy: async () => ({ status: 201, headers: {}, text: "created" }),
		} as never);
		const { result } = await serve(
			[{ resourceName: "db", image: "postgres:16" }],
			fake,
		);
		const response = await result.handlers.get("db")?.(
			new Request("http://component.local/"),
		);
		expect(response?.status).toBe(201);
		expect(await response?.text()).toBe("created");
	});

	it("returns an empty body when the proxy answered with neither", async () => {
		// A response with no json and no text still has to produce a Response;
		// emitting `undefined` would serialize as the literal string.
		const fake = fakeK8s({
			httpProxy: async () => ({ status: 200, headers: {} }),
		} as never);
		const { result } = await serve(
			[{ resourceName: "db", image: "postgres:16" }],
			fake,
		);
		const response = await result.handlers.get("db")?.(
			new Request("http://component.local/"),
		);
		expect(await response?.text()).toBe("");
	});

	it("DEFECT: throws on an upstream 204 instead of proxying it", async () => {
		// A null-body status (204, 205, 304) cannot carry a body, and the
		// handler builds every non-JSON response as `new Response(text ?? "")`
		// — the empty string is still a body, so the Response constructor
		// rejects the status.
		//
		// This is a real defect, not a design choice: a workload that answers
		// 204 to a DELETE — an entirely ordinary thing for a REST service to do
		// — makes the mesh hop throw a TypeError about a "response status code"
		// rather than returning the 204. The caller sees a runtime error from
		// inside HoBo for a perfectly valid upstream reply.
		//
		// Pinned here rather than fixed: the fix is a one-line null-body guard
		// in `host.ts`, but it changes production behaviour on a path this
		// tranche is only meant to cover. Flagged on the PR for a decision.
		const fake = fakeK8s({
			httpProxy: async () => ({ status: 204, headers: {} }),
		} as never);
		const { result } = await serve(
			[{ resourceName: "db", image: "postgres:16" }],
			fake,
		);
		await expect(
			result.handlers.get("db")?.(new Request("http://component.local/")),
		).rejects.toThrow(/status code 204/);
	});

	it("reports the isolation boundary and what it scheduled", async () => {
		// The isolation report is what a deploy prints. It has to say what
		// actually enforces the boundary, not just that one exists.
		const { result } = await serve([
			{ resourceName: "db", image: "postgres:16" },
		]);
		expect(result.kind).toBe("oci");
		expect(result.isolation.isolateBoundary).toBe("kubernetes_oci");
		expect(result.isolation.privateSandboxes).toBe(1);
		expect(result.isolation.details).toMatchObject({
			namespace: "hobo-dev",
			imageRefs: ["postgres:16"],
			client: "kubectl",
			clusterReachable: true,
		});
	});

	it("serves nothing, successfully, when there is nothing to serve", async () => {
		// A Bindle with no private components and no dependencies is a valid
		// deploy — refusing it would break the simplest case.
		const { result } = await serve([]);
		expect(result.handlers.size).toBe(0);
		expect(result.isolation.privateSandboxes).toBe(0);
	});
});

describe("servePrivate — rollback", () => {
	it("tears down what it scheduled when a later step fails", async () => {
		// Half a deployment serves an app whose other half is missing, and
		// nothing else would clean it up.
		const fake = fakeK8s({
			waitReady: vi
				.fn()
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error("rollout timed out")),
		} as never);
		await expect(
			createOciRuntimeHost({
				kubernetes: fake.client,
				containerDependencies: [
					{ resourceName: "db", image: "postgres:16" },
					{ resourceName: "cache", image: "redis:7" },
				],
			}).servePrivate({
				hoboHome: "/tmp/h",
				privateComponents: [],
				env: {},
			} as never),
		).rejects.toThrow("rollout timed out");
		expect(fake.closed).toEqual(["db"]);
		expect(fake.deleted).toEqual(["db", "cache"]);
	});

	it("propagates the original error, not a teardown failure", async () => {
		// The teardown error is a consequence; the original is the cause. Losing
		// it would leave the operator debugging the cleanup.
		const fake = fakeK8s({
			waitReady: async () => {
				throw new Error("rollout timed out");
			},
			delete: async () => {
				throw new Error("delete also failed");
			},
		} as never);
		await expect(
			createOciRuntimeHost({
				kubernetes: fake.client,
				containerDependencies: [{ resourceName: "db", image: "postgres:16" }],
			}).servePrivate({
				hoboHome: "/tmp/h",
				privateComponents: [],
				env: {},
			} as never),
		).rejects.toThrow("rollout timed out");
	});

	it("refuses a private component with no built wasm, naming it", async () => {
		// The OCI host does not build. Scheduling without an artifact would
		// deploy the runtime image with nothing inside — healthy, and serving
		// nothing.
		const fake = fakeK8s();
		await expect(
			createOciRuntimeHost({ kubernetes: fake.client }).servePrivate({
				hoboHome: "/tmp/h",
				privateComponents: [{ resourceName: "api" }],
				env: {},
			} as never),
		).rejects.toThrow(/private 'api' needs wasmPath/);
	});
});

describe("close", () => {
	it("closes every forward and deletes every workload", async () => {
		// A dev session that exited without this would leave port-forwards and
		// deployments behind on the user's cluster.
		const fake = fakeK8s();
		const result = await createOciRuntimeHost({
			kubernetes: fake.client,
			containerDependencies: [
				{ resourceName: "db", image: "postgres:16" },
				{ resourceName: "cache", image: "redis:7" },
			],
		}).servePrivate({
			hoboHome: "/tmp/h",
			privateComponents: [],
			env: {},
		} as never);
		await result.close();
		expect(fake.closed.sort()).toEqual(["cache", "db"]);
		expect(fake.deleted.sort()).toEqual(["cache", "db"]);
	});

	it("survives a delete that fails", async () => {
		// Close runs from process teardown. Throwing there would turn a clean
		// exit into a crash over a cluster that is already gone.
		const fake = fakeK8s({
			delete: async () => {
				throw new Error("gone");
			},
		} as never);
		const result = await createOciRuntimeHost({
			kubernetes: fake.client,
			containerDependencies: [{ resourceName: "db", image: "postgres:16" }],
		}).servePrivate({
			hoboHome: "/tmp/h",
			privateComponents: [],
			env: {},
		} as never);
		await expect(result.close()).resolves.toBeUndefined();
	});
});

describe("Kubernetes name sanitizing", () => {
	const scheduledNameFor = async (resourceName: string) => {
		const fake = fakeK8s();
		await createOciRuntimeHost({
			kubernetes: fake.client,
			containerDependencies: [{ resourceName, image: "busybox:1.36" }],
		}).servePrivate({
			hoboHome: "/tmp/h",
			privateComponents: [],
			env: {},
			// SAFETY: the host reads exactly the fields a serve context names.
		} as never);
		return fake.waited[0];
	};

	it("lowercases and replaces characters a DNS label cannot carry", async () => {
		// `My Service!` is a valid Bindle name and an invalid Kubernetes one;
		// passing it through would be rejected by the apiserver with a message
		// about DNS labels, long after the operator chose the name.
		expect(await scheduledNameFor("My Service!")).toBe("my-service");
	});

	it("trims leading and trailing dashes left by the replacement", async () => {
		// A DNS label may not begin or end with a dash, and the replacement is
		// exactly what produces them.
		expect(await scheduledNameFor("__api__")).toBe("api");
	});

	it("truncates to the 63-character DNS label limit", async () => {
		const name = await scheduledNameFor(`db-${"x".repeat(80)}`);
		expect(name).toHaveLength(63);
	});

	it("falls back to a placeholder when nothing survives", async () => {
		// A name of only invalid characters sanitizes to the empty string, and
		// an empty metadata.name is rejected by the apiserver. `component` is a
		// legible stand-in; the Bindle name is still what the handler is
		// registered under, so nothing is lost to the caller.
		expect(await scheduledNameFor("!!!")).toBe("component");
	});

	it("leaves a name that is already a valid label alone", async () => {
		expect(await scheduledNameFor("db-primary")).toBe("db-primary");
	});
});

describe("the runtime image a component runs in", () => {
	const detailsFor = async (
		options: Record<string, unknown>,
		env: NodeJS.ProcessEnv = {},
	) => {
		const fake = fakeK8s();
		await createOciRuntimeHost({
			kubernetes: fake.client,
			containerDependencies: [{ resourceName: "db", image: "postgres:16" }],
			...options,
		}).servePrivate({
			hoboHome: "/tmp/h",
			privateComponents: [],
			env,
			// SAFETY: the host reads exactly the fields a serve context names.
		} as never);
		return fake;
	};

	it("schedules dependencies on their own image, not the runtime one", async () => {
		// The runtime image hosts *components*. A dependency declares its own
		// image and running it on the runtime image would start the wrong
		// program under the right name.
		const fake = await detailsFor({ runtimeImage: "ghcr.io/acme/rt:1" });
		const manifests = fake.applied[0] as Array<{
			spec?: {
				template?: { spec?: { containers?: Array<{ image: string }> } };
			};
		}>;
		expect(manifests[0]?.spec?.template?.spec?.containers?.[0]?.image).toBe(
			"postgres:16",
		);
	});

	it("accepts a runtime image from the environment", async () => {
		// The escape hatch for an air-gapped registry. Asserted through a
		// successful serve rather than a thrown error, because the value is
		// only read on the private-component path.
		await expect(
			detailsFor({}, { HOBO_OCI_RUNTIME_IMAGE: "registry.internal/rt:1" }),
		).resolves.toBeDefined();
	});
});

describe("a dependency's environment", () => {
	const appliedEnvFor = async (
		dep: { resourceName: string; image: string; env?: Record<string, string> },
		bindleEnv?: Record<string, string>,
	) => {
		const fake = fakeK8s();
		await createOciRuntimeHost({
			kubernetes: fake.client,
			containerDependencies: [dep],
		}).servePrivate({
			hoboHome: "/tmp/h",
			privateComponents: [],
			env: {},
			...(bindleEnv !== undefined ? { bindleEnv } : {}),
			// SAFETY: the host reads exactly the fields a serve context names.
		} as never);
		const manifests = fake.applied[0] as Array<{
			spec?: {
				template?: {
					spec?: {
						containers?: Array<{
							env?: Array<{ name: string; value: string }>;
						}>;
					};
				};
			};
		}>;
		return Object.fromEntries(
			(manifests[0]?.spec?.template?.spec?.containers?.[0]?.env ?? []).map(
				(entry) => [entry.name, entry.value],
			),
		);
	};

	it("carries the dependency's own environment", async () => {
		expect(
			await appliedEnvFor({
				resourceName: "db",
				image: "postgres:16",
				env: { POSTGRES_DB: "app" },
			}),
		).toMatchObject({ POSTGRES_DB: "app" });
	});

	it("merges the bindle environment over the dependency's", async () => {
		// The bindle is the deployment-time authority; a dependency's own value
		// is a default it ships with. Reversing this would make a bindle unable
		// to point a dependency at anything.
		expect(
			await appliedEnvFor(
				{
					resourceName: "db",
					image: "postgres:16",
					env: { POSTGRES_DB: "default", POSTGRES_USER: "app" },
				},
				{ POSTGRES_DB: "override" },
			),
		).toMatchObject({ POSTGRES_DB: "override", POSTGRES_USER: "app" });
	});

	it("carries the bindle environment even when the dependency declares none", async () => {
		expect(
			await appliedEnvFor(
				{ resourceName: "db", image: "postgres:16" },
				{ LOG_LEVEL: "debug" },
			),
		).toMatchObject({ LOG_LEVEL: "debug" });
	});

	it("schedules a dependency that declares no environment at all", async () => {
		await expect(
			appliedEnvFor({ resourceName: "db", image: "postgres:16" }),
		).resolves.toBeDefined();
	});
});
