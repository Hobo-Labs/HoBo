import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseAllDocuments, parseDocument } from "yaml";
import { checkDeployment } from "../scripts/check-deployment.js";

async function shipped() {
	const root = new URL("../deploy/", import.meta.url);
	const [compose, kubernetes, dockerfile] = await Promise.all(
		["compose.yml", "kubernetes.yaml", "Dockerfile"].map((name) =>
			readFile(new URL(name, root), "utf8"),
		),
	);
	if (
		compose === undefined ||
		kubernetes === undefined ||
		dockerfile === undefined
	)
		throw new Error("missing deployment fixture");
	return { compose, kubernetes, dockerfile };
}

describe("deployable relay partition", () => {
	it("parses the shipped manifests and checks storage, secrets, probes and process ownership together", async () => {
		const files = await shipped();
		expect(() => checkDeployment(files)).not.toThrow();
	});

	it.each([
		{
			name: "multiple SQLite writers",
			path: ["services", "relay", "deploy", "replicas"],
			value: 2,
			error: /one SQLite writer/,
		},
		{
			name: "root relay",
			path: ["services", "relay", "user"],
			value: "0:0",
			error: /nonroot readonly/,
		},
		{
			name: "public plaintext listener",
			path: ["services", "relay", "ports"],
			value: ["0.0.0.0:8787:8787"],
			error: /loopback proxy/,
		},
		{
			name: "ephemeral ledger",
			path: ["services", "relay", "environment", "HOBO_CI_DB"],
			value: "/tmp/relay.sqlite",
			error: /persistent SQLite/,
		},
		{
			name: "unmounted token file",
			path: ["services", "relay", "environment", "HOBO_CI_CONTROL_TOKENS_FILE"],
			value: "/run/secrets/missing",
			error: /mounted secret/,
		},
		{
			name: "plaintext webhook secret",
			path: ["services", "relay", "environment", "HOBO_CI_WEBHOOK_SECRET"],
			value: "local-negative-control",
			error: /plaintext webhook/,
		},
	])("refuses compose $name before deployment", async ({
		path,
		value,
		error,
	}) => {
		const files = await shipped();
		const document = parseDocument(files.compose);
		document.setIn(path, value);
		expect(() =>
			checkDeployment({ ...files, compose: document.toString() }),
		).toThrow(error);
	});

	it.each([
		{
			name: "overlapping rolling update",
			path: ["spec", "strategy", "type"],
			value: "RollingUpdate",
			error: /Recreate/,
		},
		{
			name: "ephemeral ledger path",
			path: ["spec", "template", "spec", "containers", 0, "env", 2, "value"],
			value: "/tmp/relay.sqlite",
			error: /pod ledger/,
		},
		{
			name: "missing projected token file",
			path: [
				"spec",
				"template",
				"spec",
				"volumes",
				2,
				"secret",
				"items",
				2,
				"path",
			],
			value: "wrong-token-filename.json",
			error: /projected secret file/,
		},
		{
			name: "cluster token exposure",
			path: ["spec", "template", "spec", "automountServiceAccountToken"],
			value: true,
			error: /no cluster token/,
		},
		{
			name: "unwritable PVC ownership",
			path: ["spec", "template", "spec", "securityContext", "fsGroup"],
			value: 0,
			error: /volume ownership/,
		},
		{
			name: "readiness that ignores draining",
			path: [
				"spec",
				"template",
				"spec",
				"containers",
				0,
				"readinessProbe",
				"httpGet",
				"path",
			],
			value: "/healthz",
			error: /separate readiness/,
		},
		{
			name: "writable root filesystem",
			path: [
				"spec",
				"template",
				"spec",
				"containers",
				0,
				"securityContext",
				"readOnlyRootFilesystem",
			],
			value: false,
			error: /capability confinement/,
		},
	])("refuses Kubernetes $name before deployment", async ({
		path,
		value,
		error,
	}) => {
		const files = await shipped();
		const documents = parseAllDocuments(files.kubernetes);
		const deployment = documents.find(
			(document) => document.get("kind") === "Deployment",
		);
		if (!deployment) throw new Error("missing deployment fixture");
		deployment.setIn(path, value);
		expect(() =>
			checkDeployment({
				...files,
				kubernetes: documents
					.map((document) => document.toString())
					.join("\n---\n"),
			}),
		).toThrow(error);
	});

	it("rejects a shell wrapper that would consume the relay's shutdown signal", async () => {
		const files = await shipped();
		const dockerfile = files.dockerfile.replace(
			/^ENTRYPOINT .+$/m,
			'ENTRYPOINT ["sh", "-c", "node dist/main.js"]',
		);
		expect(() => checkDeployment({ ...files, dockerfile })).toThrow(
			/receives signals/,
		);
	});

	it("rejects a Docker socket hidden in a long-form bind mount", async () => {
		const files = await shipped();
		const document = parseDocument(files.compose);
		document.addIn(["services", "relay", "volumes"], {
			type: "bind",
			source: "/var/run/docker.sock",
			target: "/run/docker.sock",
			read_only: true,
		});
		expect(() =>
			checkDeployment({ ...files, compose: document.toString() }),
		).toThrow(/no host Docker socket/);
	});
});
