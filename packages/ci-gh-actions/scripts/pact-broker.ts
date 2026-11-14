import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import type { VerifierOptions } from "@pact-foundation/pact";
import { z } from "zod";
import {
	consumer,
	generateLocalRunnerPact,
	provider,
	scenarios,
	verifyLocalRunnerPact,
} from "../contracts/local-runner-pact.js";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../..", import.meta.url));
const versionName = z
	.string()
	.regex(/^[A-Za-z0-9._-]{1,160}$/)
	.refine((value) => ![".", ".."].includes(value));
const matrixResult = z.object({
	summary: z.object({
		deployable: z.boolean().nullable(),
		success: z.number().int().nonnegative(),
		failed: z.number().int().nonnegative(),
		unknown: z.number().int().nonnegative(),
	}),
});
const contractIdentity = z.object({
	consumer: z.object({ name: z.string() }),
	provider: z.object({ name: z.string() }),
	interactions: z.array(z.json()),
});

export function pactBrokerClient(address: string, token?: string) {
	if (token && !/^[\x21-\x7e]+$/.test(token))
		throw new Error("Invalid Pact Broker credential binding");
	const origin = new URL(address);
	if (
		origin.username ||
		origin.password ||
		origin.search ||
		origin.hash ||
		origin.pathname !== "/" ||
		(origin.protocol !== "https:" &&
			!(
				origin.protocol === "http:" &&
				["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
			))
	)
		throw new Error(
			"Pact Broker must be an HTTPS origin or loopback HTTP origin without embedded credentials",
		);
	const send = async (
		path: string,
		method = "GET",
		body?: string,
		allowNotFound = false,
	) => {
		const headers = new Headers({
			Accept: "application/hal+json",
			"Content-Type": "application/json",
		});
		if (token) headers.set("Authorization", `Bearer ${token}`);
		const request: RequestInit = {
			method,
			headers,
			redirect: "error",
			signal: AbortSignal.timeout(30000),
		};
		if (body !== undefined) request.body = body;
		const response = await fetch(new URL(path, origin), request);
		if (!response.ok && !(allowNotFound && response.status === 404))
			throw new Error(`Pact Broker ${method} failed (${response.status})`);
		return response;
	};
	const matrix = async (
		consumerVersion: string,
		providerVersion: string,
		pair = { consumer, provider },
	) => {
		const query = new URLSearchParams();
		for (const [name, version] of [
			[pair.consumer, consumerVersion],
			[pair.provider, providerVersion],
		]) {
			query.append("q[][pacticipant]", name);
			query.append("q[][version]", version);
		}
		const response = await send(`/matrix?${query}`);
		return matrixResult.parse(await response.json()).summary;
	};
	return {
		origin: origin.origin,
		matrix,
		async publish(file: string, version: string, branch: string) {
			versionName.parse(version);
			const artifact = await readFile(file, "utf8");
			const identity = z
				.object({
					consumer: z.object({ name: z.string() }),
					provider: z.object({ name: z.string() }),
				})
				.parse(JSON.parse(artifact));
			const c = encodeURIComponent(identity.consumer.name);
			const p = encodeURIComponent(identity.provider.name);
			const v = encodeURIComponent(version);
			const path = `/pacts/provider/${p}/consumer/${c}/version/${v}`;
			const existing = await send(path, "GET", undefined, true);
			if (existing.status !== 404)
				assert.deepEqual(
					contractIdentity.parse(await existing.json()),
					contractIdentity.parse(JSON.parse(artifact)),
					"Published consumer contract versions are immutable; use the new source version",
				);
			await send(path, "PUT", artifact);
			await send(
				`/pacticipants/${c}/branches/${encodeURIComponent(branch)}/versions/${v}`,
				"PUT",
				"{}",
			);
			return new URL(path, origin).href;
		},
		async canDeploy(consumerVersion: string, providerVersion: string) {
			const result = await matrix(consumerVersion, providerVersion);
			return (
				result.deployable === true &&
				result.success > 0 &&
				result.failed === 0 &&
				result.unknown === 0
			);
		},
	};
}

async function main() {
	const { values } = parseArgs({
		options: {
			"broker-url": { type: "string" },
			version: { type: "string" },
			branch: { type: "string", default: "local" },
			evidence: { type: "string" },
			worker: { type: "string" },
			pact: { type: "string" },
			fault: { type: "boolean" },
			gate: { type: "boolean" },
			act: { type: "string" },
		},
	});
	if (values.worker) {
		assert.ok(values.version && values.pact);
		assert.equal(values.worker, "verify");
		const broker = pactBrokerClient(
			values["broker-url"] ??
				process.env.PACT_BROKER_BASE_URL ??
				"http://127.0.0.1:9292",
		);
		const source = new URL(values.pact);
		assert.equal(
			source.origin,
			broker.origin,
			"verification must fetch contracts only from the configured broker",
		);
		assert.ok(
			!source.username &&
				!source.password &&
				source.pathname.startsWith(
					`/pacts/provider/${provider}/consumer/${consumer}/`,
				),
		);
		const options: VerifierOptions = {
			pactUrls: [values.pact],
			providerVersion: values.version,
			providerVersionBranch: values.branch,
			publishVerificationResult: true,
		};
		if (process.env.PACT_BROKER_TOKEN)
			options.pactBrokerToken = process.env.PACT_BROKER_TOKEN;
		await verifyLocalRunnerPact(options, values.fault);
		return;
	}
	const address =
		values["broker-url"] ??
		process.env.PACT_BROKER_BASE_URL ??
		"http://127.0.0.1:9292";
	const parsedVersion = versionName.safeParse(values.version);
	if (!parsedVersion.success)
		throw new Error(
			"Pass --version with the reviewed source version (letters, digits, dot, underscore or hyphen)",
		);
	const version = parsedVersion.data;
	const broker = pactBrokerClient(address, process.env.PACT_BROKER_TOKEN);
	if (values.gate) {
		const local = await broker.matrix(version, version);
		process.stdout.write(`${JSON.stringify({ local })}\n`);
		if (
			!(
				local.deployable === true &&
				local.success > 0 &&
				local.failed === 0 &&
				local.unknown === 0
			)
		)
			throw new Error(
				"Pact deployment blocked: failed or unverified integration boundary",
			);
		return;
	}
	const base = resolve(
		values.evidence ?? join(root, ".hobo", "ci-local", "pact-evidence"),
	);
	await mkdir(base, { recursive: true });
	const directory = await mkdtemp(join(base, "run-"));
	const record = async (name: string, args: string[], cwd = root) => {
		try {
			const result = await execute(process.execPath, args, {
				cwd,
				env: process.env,
				timeout: 120000,
				maxBuffer: 8 * 1024 * 1024,
			});
			await writeFile(
				join(directory, `${name}.log`),
				result.stdout + result.stderr,
				{ mode: 0o600 },
			);
			return result.stdout;
		} catch (error) {
			const output = z
				.object({ stdout: z.string(), stderr: z.string() })
				.safeParse(error);
			if (output.success)
				await writeFile(
					join(directory, `${name}.log`),
					output.data.stdout + output.data.stderr,
					{ mode: 0o600 },
				);
			throw new Error(
				`Pact prerequisite ${name} failed; inspect its evidence log`,
			);
		}
	};
	const nativeTests = [
		"test/bootstrap.test.ts",
		"test/local-provider.test.ts",
		"test/pact-broker.test.ts",
	];
	await record(
		"native-scenarios",
		[join(root, "node_modules/vitest/vitest.mjs"), "run", ...nativeTests],
		join(root, "packages/ci-gh-actions"),
	);
	const act = resolve(values.act ?? join(root, ".tools/ci/act"));
	const corpus = z
		.object({
			completedJobs: z.number().int().positive(),
			scenarios: z.array(
				z.object({
					scenario: z.string(),
					jobs: z.number().int().nonnegative(),
					denied: z.boolean(),
				}),
			),
		})
		.parse(
			JSON.parse(
				await record("act-corpus", [
					"--import",
					"tsx",
					"packages/ci-gh-actions/scripts/act-harness.ts",
					"--act",
					act,
					"--evidence",
					join(directory, "act"),
				]),
			),
		);
	await record("local-acceptance", [
		"--import",
		"tsx",
		"packages/ci-gh-actions/scripts/acceptance.ts",
		"--local",
		"--act",
		act,
		"--evidence",
		join(directory, "local"),
	]);
	const reports = await readdir(join(directory, "local"));
	assert.equal(reports.length, 1);
	const local = z
		.object({
			executions: z.array(z.object({ provider: z.literal("local") })).length(2),
			paidMicros: z.literal(0),
			replayPreserved: z.literal(true),
		})
		.parse(
			JSON.parse(
				await readFile(
					join(directory, "local", reports[0] ?? "", "report.json"),
					"utf8",
				),
			),
		);
	for (const fault of ["missing-jit", "wrong-provider", "skip-job"])
		await assert.rejects(
			record(`fault-${fault}`, [
				"--import",
				"tsx",
				"packages/ci-gh-actions/scripts/acceptance.ts",
				"--local",
				"--act",
				act,
				"--fault",
				fault,
				"--evidence",
				join(directory, fault),
			]),
		);
	const file = await generateLocalRunnerPact(directory);
	const pactUrl = await broker.publish(file, version, values.branch);
	const changed = contractIdentity.parse(
		JSON.parse(await readFile(file, "utf8")),
	);
	changed.interactions.push({
		description: "forbidden replacement of a published version",
	});
	const changedFile = join(directory, "immutable-version-probe.json");
	await writeFile(changedFile, JSON.stringify(changed));
	await assert.rejects(
		broker.publish(changedFile, version, values.branch),
		/Published consumer contract versions are immutable/,
	);
	const missingVersion = `${version}-unverified`;
	assert.equal(
		await broker.canDeploy(version, missingVersion),
		false,
		"missing provider verification must block deployment",
	);
	// Pact JS ignores NO_PROXY for its Node provider proxy. The isolated worker
	// connects directly to its loopback provider; Rust retains proxy access to a
	// shared HTTPS broker through ALL_PROXY. No provider credential is forwarded.
	const env = {
		...process.env,
		HTTP_PROXY: "",
		HTTPS_PROXY: "",
		ALL_PROXY:
			process.env.ALL_PROXY ??
			process.env.HTTPS_PROXY ??
			process.env.HTTP_PROXY ??
			"",
		NO_PROXY: `127.0.0.1,localhost,${process.env.NO_PROXY ?? ""}`,
	};
	const result = await execute(
		process.execPath,
		[
			"--import",
			"tsx",
			fileURLToPath(import.meta.url),
			"--worker",
			"verify",
			"--pact",
			pactUrl,
			"--broker-url",
			broker.origin,
			"--version",
			version,
			"--branch",
			values.branch,
		],
		{ cwd: root, env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
	);
	await writeFile(join(directory, "provider-verification.log"), result.stdout, {
		mode: 0o600,
	});
	assert.equal(
		await broker.canDeploy(version, version),
		true,
		"verified exact consumer/provider versions must be deployable",
	);
	assert.equal(
		await broker.canDeploy(version, missingVersion),
		false,
		"another provider version must not inherit this verification",
	);
	const brokenVersion = `${version}-broken`;
	await assert.rejects(
		execute(
			process.execPath,
			[
				"--import",
				"tsx",
				fileURLToPath(import.meta.url),
				"--worker",
				"verify",
				"--pact",
				pactUrl,
				"--broker-url",
				broker.origin,
				"--version",
				brokenVersion,
				"--branch",
				`${values.branch}-negative-control`,
				"--fault",
			],
			{ cwd: root, env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
		),
	);
	const broken = await broker.matrix(version, brokenVersion);
	assert.equal(broken.deployable, false);
	assert.ok(
		broken.failed > 0 && broken.unknown === 0,
		"a published failed verification must block deployment (unknown is insufficient)",
	);
	const report = {
		broker: broker.origin,
		consumer,
		provider,
		consumerVersion: version,
		providerVersion: version,
		branch: values.branch,
		pactSha256: createHash("sha256")
			.update(await readFile(file))
			.digest("hex"),
		negativeProviderVersion: brokenVersion,
		failedMatrix: broken,
		scenarios,
		nativeTests,
		actCorpus: corpus,
		localExecutions: local.executions.length,
		verified: true,
		missingVerificationBlocked: true,
		versionSkewBlocked: true,
		failedVerificationBlocked: true,
		contractMutationBlocked: true,
	};
	await writeFile(
		join(directory, "report.json"),
		`${JSON.stringify(report, null, 2)}\n`,
	);
	process.stdout.write(
		`${JSON.stringify({ ...report, evidenceDirectory: directory }, null, 2)}\n`,
	);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href)
	main().catch((error) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : "Pact broker validation failed"}\n`,
		);
		process.exitCode = 1;
	});
