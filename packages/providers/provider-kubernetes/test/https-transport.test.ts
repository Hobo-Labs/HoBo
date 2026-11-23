import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createKubernetesHttpsTransport,
	KubernetesProviderError,
} from "../src/index.js";

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

type Pair = Readonly<{ cert: string; key: string }>;

function selfSigned(directory: string, name: string, san: string): Pair {
	const key = join(directory, `${name}.key`);
	const cert = join(directory, `${name}.crt`);
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"ec",
			"-pkeyopt",
			"ec_paramgen_curve:prime256v1",
			"-nodes",
			"-days",
			"1",
			"-subj",
			`/CN=${name}`,
			"-addext",
			san,
			"-keyout",
			key,
			"-out",
			cert,
		],
		{ stdio: "ignore" },
	);
	return {
		cert: readFileSync(cert, "utf8"),
		key: readFileSync(key, "utf8"),
	};
}

describe.skipIf(!hasOpenssl)("createKubernetesHttpsTransport", () => {
	let directory = "";
	let server: Server | undefined;
	let origin = "";
	let serverPair: Pair;
	let clientPair: Pair;
	const seen: { method?: string; length?: string; body?: string }[] = [];

	beforeAll(async () => {
		directory = mkdtempSync(join(tmpdir(), "hobo-k8s-tls-"));
		serverPair = selfSigned(
			directory,
			"apiserver",
			"subjectAltName=IP:127.0.0.1",
		);
		clientPair = selfSigned(
			directory,
			"fleet-admin",
			"extendedKeyUsage=clientAuth",
		);
		const listening = createServer(
			{
				...serverPair,
				ca: clientPair.cert,
				requestCert: true,
				rejectUnauthorized: true,
			},
			(request, response) => {
				let body = "";
				request.on("data", (chunk: Buffer) => {
					body += chunk.toString("utf8");
				});
				request.on("end", () => {
					seen.push({
						method: request.method ?? "",
						length: request.headers["content-length"] ?? "",
						body,
					});
					response.writeHead(200, { "Content-Type": "application/json" });
					response.end(
						request.url === "/big"
							? JSON.stringify({ filler: "x".repeat(4096) })
							: JSON.stringify({ kind: "Status", code: 200 }),
					);
				});
			},
		);
		server = listening;
		await new Promise<void>((resolve) => {
			listening.listen(0, "127.0.0.1", resolve);
		});
		const address: AddressInfo | string | null = listening.address();
		if (address === null || !(address instanceof Object))
			throw new Error("the test apiserver has no TCP address");
		origin = `https://127.0.0.1:${address.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => {
			server?.close(() => resolve());
		});
		rmSync(directory, { recursive: true, force: true });
	});

	it("verifies the apiserver against the kubeconfig CA and presents the client certificate", async () => {
		const transport = createKubernetesHttpsTransport({
			ca: serverPair.cert,
			cert: clientPair.cert,
			key: clientPair.key,
		});
		const body = JSON.stringify([{ op: "add", path: "/a", value: 1 }]);
		const response = await transport({
			method: "PATCH",
			url: `${origin}/apis/actions.github.com/v1alpha1/namespaces/a/autoscalingrunnersets/b`,
			headers: { "Content-Type": "application/json-patch+json" },
			body,
			timeoutMs: 5000,
			maxResponseBytes: 1024,
		});
		expect(response.status).toBe(200);
		expect(response.headers["content-type"]).toBe("application/json");
		expect(seen.at(-1)).toEqual({
			method: "PATCH",
			length: String(Buffer.byteLength(body)),
			body,
		});
	});

	it("refuses an apiserver the CA does not vouch for", async () => {
		const transport = createKubernetesHttpsTransport({
			cert: clientPair.cert,
			key: clientPair.key,
		});
		await expect(
			transport({
				method: "GET",
				url: `${origin}/apis/batch/v1/namespaces/a/jobs`,
				headers: {},
				timeoutMs: 5000,
				maxResponseBytes: 1024,
			}),
		).rejects.toBeInstanceOf(KubernetesProviderError);
	});

	it("stops reading past the response cap", async () => {
		const transport = createKubernetesHttpsTransport({
			ca: serverPair.cert,
			cert: clientPair.cert,
			key: clientPair.key,
		});
		const failure = await transport({
			method: "GET",
			url: `${origin}/big`,
			headers: {},
			timeoutMs: 5000,
			maxResponseBytes: 512,
		}).then(
			() => undefined,
			(error) => error,
		);
		expect(failure).toBeInstanceOf(KubernetesProviderError);
		expect(
			failure instanceof KubernetesProviderError ? failure.code : undefined,
		).toBe("PROVIDER_CONTRACT_CHANGED");
	});
});
