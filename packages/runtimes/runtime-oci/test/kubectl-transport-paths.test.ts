import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	createProcessKubectlTransport,
	KubectlUnavailableError,
} from "../src/kubectl-transport.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function fakeKubectl(script: Record<string, [number, string]> = {}): {
	bin: string;
	calls: () => string[][];
} {
	const dir = mkdtempSync(join(tmpdir(), "hobo-kubectl-"));
	dirs.push(dir);
	const bin = join(dir, "kubectl");
	const log = join(dir, "calls.log");
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			`const script = ${JSON.stringify(script)};`,
			"const argv = process.argv.slice(2);",
			`fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n');`,
			"const entry = script[argv[0]] ?? script[argv.join(' ')];",
			"if (entry) { process.stdout.write(entry[1]); process.exit(entry[0]); }",
			"process.exit(0);",
		].join("\n"),
		{ mode: 0o755 },
	);
	chmodSync(bin, 0o755);
	return {
		bin,
		calls: () => {
			try {
				return readFileSync(log, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as string[]);
			} catch {
				return [];
			}
		},
	};
}

function transport(
	script: Record<string, [number, string]> = {},
	options: { context?: string } = {},
) {
	const fake = fakeKubectl(script);
	return {
		...fake,
		transport: createProcessKubectlTransport({
			kubectlBin: fake.bin,
			env: { PATH: process.env.PATH ?? "" },
			...(options.context !== undefined ? { context: options.context } : {}),
		}),
	};
}

describe("binary selection", () => {
	it("names itself for the PACT boundary it implements", () => {
		expect(createProcessKubectlTransport().name).toBe("KubernetesClusterApi");
	});

	it("takes the binary from the option, then the environment, then PATH", () => {
		const fake = fakeKubectl({ version: [0, '{"clientVersion":{}}'] });
		const fromEnv = createProcessKubectlTransport({
			env: { HOBO_KUBECTL_BIN: fake.bin, PATH: dirname(process.execPath) },
		});
		return fromEnv
			.handle({ method: "GET", path: "/kubectl/version" })
			.then((response) => {
				expect(response.status).toBe(200);
				expect((response.body as { kubectlBin: string }).kubectlBin).toBe(
					fake.bin,
				);
			});
	});

	it("passes --context ahead of every subcommand when one is configured", async () => {
		const { transport: t, calls } = transport(
			{ "cluster-info": [0, "reachable"] },
			{ context: "staging" },
		);
		await t.handle({ method: "GET", path: "/kubectl/cluster-info" });
		expect(calls()[0]?.slice(0, 2)).toEqual(["--context", "staging"]);
	});

	it("omits the context flag when none is configured", async () => {
		const { transport: t, calls } = transport({ "cluster-info": [0, "ok"] });
		await t.handle({ method: "GET", path: "/kubectl/cluster-info" });
		expect(calls()[0]).not.toContain("--context");
	});
});

describe("/kubectl/version", () => {
	it("reports the client version parsed from the CLI's own JSON", async () => {
		const { transport: t } = transport({
			version: [0, '{"clientVersion":{"gitVersion":"v1.31.0"}}'],
		});
		const response = await t.handle({
			method: "GET",
			path: "/kubectl/version",
		});
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ ok: true, clientVersion: "v1.31.0" });
	});

	it("asks only for the client version, so it works with no cluster", async () => {
		const { transport: t, calls } = transport({
			version: [0, '{"clientVersion":{}}'],
		});
		await t.handle({ method: "GET", path: "/kubectl/version" });
		expect(calls()[0]).toContain("--client=true");
	});

	it("reports 503 with the CLI's message when kubectl fails", async () => {
		const { transport: t } = transport({ version: [1, "command not found"] });
		const response = await t.handle({
			method: "GET",
			path: "/kubectl/version",
		});
		expect(response.status).toBe(503);
		expect(response.body).toMatchObject({ ok: false });
		expect(String((response.body as { error: string }).error)).toContain(
			"command not found",
		);
	});

	it("reports `unknown` rather than failing when the JSON does not parse", async () => {
		const { transport: t } = transport({ version: [0, "not json"] });
		const response = await t.handle({
			method: "GET",
			path: "/kubectl/version",
		});
		expect(response.body).toMatchObject({ ok: true, clientVersion: "unknown" });
	});

	it("reports null when the JSON parses but names no version", async () => {
		const { transport: t } = transport({ version: [0, "{}"] });
		expect(
			(await t.handle({ method: "GET", path: "/kubectl/version" })).body,
		).toMatchObject({ clientVersion: null });
	});
});

describe("/kubectl/cluster-info", () => {
	it("reports reachable with the CLI's output", async () => {
		const { transport: t } = transport({
			"cluster-info": [0, "Kubernetes control plane is running at https://k8s"],
		});
		const response = await t.handle({
			method: "GET",
			path: "/kubectl/cluster-info",
		});
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ ok: true, reachable: true });
		expect(String((response.body as { detail: string }).detail)).toContain(
			"control plane",
		);
	});

	it("reports unreachable as 503 rather than throwing", async () => {
		const { transport: t } = transport({
			"cluster-info": [1, "connection refused"],
		});
		const response = await t.handle({
			method: "GET",
			path: "/kubectl/cluster-info",
		});
		expect(response.status).toBe(503);
		expect(response.body).toMatchObject({ ok: false, reachable: false });
	});
});

describe("/kubectl/namespace/ensure", () => {
	it("does nothing when the namespace already exists", async () => {
		const { transport: t, calls } = transport({ get: [0, "namespace/hobo"] });
		const response = await t.handle({
			method: "POST",
			path: "/kubectl/namespace/ensure",
			body: { namespace: "hobo" },
		});
		expect(response.body).toMatchObject({ ok: true, namespace: "hobo" });
		expect(calls().some((call) => call.includes("apply"))).toBe(false);
	});

	it("creates the namespace when the lookup fails", async () => {
		const { transport: t, calls } = transport({ get: [1, "not found"] });
		await t.handle({
			method: "POST",
			path: "/kubectl/namespace/ensure",
			body: { namespace: "hobo" },
		});
		expect(calls().some((call) => call.includes("apply"))).toBe(true);
	});

	it("defaults the namespace rather than creating one named `undefined`", async () => {
		const { transport: t, calls } = transport({
			get: [0, "namespace/default"],
		});
		const response = await t.handle({
			method: "POST",
			path: "/kubectl/namespace/ensure",
			body: {},
		});
		expect(response.body).toMatchObject({ namespace: "default" });
		expect(calls()[0]).toContain("default");
	});

	it("throws when the create itself fails", async () => {
		const { transport: t } = transport({
			get: [1, "nf"],
			apply: [1, "denied"],
		});
		await expect(
			t.handle({
				method: "POST",
				path: "/kubectl/namespace/ensure",
				body: { namespace: "hobo" },
			}),
		).rejects.toThrow(KubectlUnavailableError);
	});
});

describe("/kubectl/apply", () => {
	it("applies each manifest into the requested namespace", async () => {
		const { transport: t, calls } = transport();
		const response = await t.handle({
			method: "POST",
			path: "/kubectl/apply",
			body: {
				namespace: "hobo",
				manifests: [{ kind: "Deployment" }, { kind: "Service" }],
			},
		});
		expect(response.body).toMatchObject({ ok: true, applied: 2 });
		const applies = calls().filter((call) => call.includes("apply"));
		expect(applies).toHaveLength(2);
		expect(applies[0]).toEqual(["apply", "-n", "hobo", "-f", "-"]);
	});

	it("stamps the namespace onto each manifest's metadata", async () => {
		const { transport: t, calls } = transport();
		await t.handle({
			method: "POST",
			path: "/kubectl/apply",
			body: {
				namespace: "hobo",
				manifests: [{ kind: "Deployment", metadata: { namespace: "other" } }],
			},
		});
		expect(calls()[0]).toEqual(["apply", "-n", "hobo", "-f", "-"]);
	});

	it("succeeds with nothing to apply", async () => {
		const { transport: t, calls } = transport();
		const response = await t.handle({
			method: "POST",
			path: "/kubectl/apply",
			body: { namespace: "hobo", manifests: [] },
		});
		expect(response.body).toMatchObject({ applied: 0 });
		expect(calls()).toEqual([]);
	});

	it("treats a missing manifests list as empty", async () => {
		const { transport: t } = transport();
		expect(
			(await t.handle({ method: "POST", path: "/kubectl/apply", body: {} }))
				.body,
		).toMatchObject({ applied: 0 });
	});

	it("throws with the exit code and stderr when an apply fails", async () => {
		const { transport: t } = transport({
			apply: [1, "admission webhook denied"],
		});
		await expect(
			t.handle({
				method: "POST",
				path: "/kubectl/apply",
				body: { manifests: [{ kind: "Deployment" }] },
			}),
		).rejects.toThrow(/exit 1.*admission webhook denied/su);
	});

	it("tags the failure with a stable code", async () => {
		const { transport: t } = transport({ apply: [1, "denied"] });
		await t
			.handle({
				method: "POST",
				path: "/kubectl/apply",
				body: { manifests: [{}] },
			})
			.then(
				() => expect.unreachable(),
				(error: KubectlUnavailableError) => {
					expect(error.code).toBe("HOBO_KUBECTL_UNAVAILABLE");
					expect(error.name).toBe("KubectlUnavailableError");
				},
			);
	});
});

describe("/kubectl/rollout-status", () => {
	it("reports ready when the rollout completes", async () => {
		const { transport: t } = transport({
			rollout: [0, "successfully rolled out"],
		});
		const response = await t.handle({
			method: "POST",
			path: "/kubectl/rollout-status",
			body: { namespace: "hobo", name: "web", timeoutMs: 1000 },
		});
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ ok: true, ready: true });
	});

	it("passes the timeout to kubectl in whole seconds, never below one", async () => {
		const { transport: t, calls } = transport({ rollout: [0, "ok"] });
		await t.handle({
			method: "POST",
			path: "/kubectl/rollout-status",
			body: { name: "web", timeoutMs: 1 },
		});
		expect(calls()[0]?.join(" ")).toContain("--timeout=1s");
	});

	it("falls back to polling endpoints when the rollout command fails", async () => {
		const { transport: t } = transport({
			rollout: [1, "progress deadline"],
			get: [0, "10.1.2.3"],
		});
		const response = await t.handle({
			method: "POST",
			path: "/kubectl/rollout-status",
			body: { name: "web", timeoutMs: 2000 },
		});
		expect(response.body).toMatchObject({ ok: true, ready: true });
	});

	it("times out as 504 carrying the rollout's own error", async () => {
		const { transport: t } = transport({
			rollout: [1, "progress deadline exceeded"],
			get: [0, "   "],
		});
		const response = await t.handle({
			method: "POST",
			path: "/kubectl/rollout-status",
			body: { name: "web", timeoutMs: 600 },
		});
		expect(response.status).toBe(504);
		expect(response.body).toMatchObject({ ok: false, ready: false });
	});
});

describe("/kubectl/http-proxy", () => {
	it("refuses when no port-forward is active for the service", async () => {
		const { transport: t } = transport();
		const response = await t.handle({
			method: "POST",
			path: "/kubectl/http-proxy",
			body: { service: "web", path: "/health" },
		});
		expect(response.status).toBe(503);
		expect(String((response.body as { error: string }).error)).toContain("web");
	});
});

describe("/kubectl/resources DELETE", () => {
	it("deletes the deployment and service without waiting", async () => {
		const { transport: t, calls } = transport();
		const response = await t.handle({
			method: "DELETE",
			path: "/kubectl/resources",
			body: { namespace: "hobo", name: "web" },
		});
		expect(response.body).toMatchObject({ ok: true, deleted: true });
		const args = calls()[0]?.join(" ") ?? "";
		expect(args).toContain("delete deployment,service web");
		expect(args).toContain("--ignore-not-found=true");
		expect(args).toContain("--wait=false");
	});

	it("reports success even when the delete command fails", async () => {
		const { transport: t } = transport({ delete: [1, "no such deployment"] });
		expect(
			(
				await t.handle({
					method: "DELETE",
					path: "/kubectl/resources",
					body: { name: "web" },
				})
			).body,
		).toMatchObject({ ok: true });
	});

	it("only answers DELETE on that path", async () => {
		const { transport: t } = transport();
		expect(
			(await t.handle({ method: "GET", path: "/kubectl/resources" })).status,
		).toBe(404);
	});
});

describe("unknown paths", () => {
	it("answers 404 naming the path rather than silently doing nothing", async () => {
		const { transport: t } = transport();
		const response = await t.handle({
			method: "GET",
			path: "/kubectl/frobnicate",
		});
		expect(response.status).toBe(404);
		expect(String((response.body as { error: string }).error)).toContain(
			"/kubectl/frobnicate",
		);
	});
});
