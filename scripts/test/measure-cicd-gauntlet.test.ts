import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	type GauntletInput,
	measureGauntlet,
} from "../ci/measure-cicd-gauntlet.mts";

function atIndex<T>(values: T[], index = 0): T {
	const value = values[index];
	assert.ok(value !== undefined);
	return value;
}

const sha = "a".repeat(40);
const configDigest = `sha256:${"a".repeat(64)}`;
const layerDigest = `sha256:${"b".repeat(64)}`;
const manifest = JSON.stringify({
	schemaVersion: 2,
	config: { digest: configDigest, size: 17 },
	layers: [{ digest: layerDigest, size: 29 }],
});
const manifestDigest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
const at = (seconds: number) =>
	new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

function success(duration: number): GauntletInput {
	const ciRun = {
		id: 1,
		head_sha: sha,
		status: "completed",
		conclusion: "success",
		created_at: at(0),
		updated_at: at(100),
		run_attempt: 1,
	};
	return {
		ci: {
			run: ciRun,
			jobs: {
				total_count: 1,
				jobs: [
					{
						name: "ci",
						status: "completed",
						conclusion: "success",
						started_at: at(30),
						completed_at: at(100),
					},
				],
			},
		},
		cd: [
			{
				run: {
					id: 2,
					head_sha: sha,
					status: "completed",
					conclusion: "success",
					created_at: at(101),
					updated_at: at(duration),
					run_attempt: 1,
				},
				jobs: {
					total_count: 1,
					jobs: [
						{
							name: "publish",
							status: "completed",
							conclusion: "success",
							started_at: at(140),
							completed_at: at(duration),
						},
					],
				},
				event: { action: "completed", workflow_run: { ...ciRun } },
			},
		],
		requirements: [
			{
				deployable: "mcp",
				publicOci: {
					required: true,
					digest: manifestDigest,
					manifest,
					manifestStatus: 200,
					anonymous: true,
					blobs: [configDigest, layerDigest].map((digest) => ({
						digest,
						actualDigest: digest,
						actualSize: digest === configDigest ? 17 : 29,
						status: 200,
						anonymous: true,
					})),
					evidence: ["anonymous manifest and blob probe"],
				},
				jobs: [
					{ stage: "ci", name: "ci" },
					{ stage: "cd", name: "publish" },
				],
			},
		],
		cache: {
			state: "warm",
			evidence: ["cache restore log"],
			deployables: {
				mcp: { state: "warm", evidence: ["mcp cache restore log"] },
			},
		},
	};
}

test("uses the complete interval, including time before the first jobs", () => {
	const result = measureGauntlet(success(599));
	assert.equal(result.durationSeconds, 599);
	assert.equal(result.passed, true);
	assert.equal(atIndex(result.queue, 0).beforeFirstJobSeconds, 30);
	assert.equal(atIndex(result.queue, 1).beforeFirstJobSeconds, 39);
});

test("includes job completion when it follows the workflow update timestamp", () => {
	const input = success(599);
	atIndex(atIndex(input.cd).jobs.jobs).completed_at = at(610);
	const result = measureGauntlet(input);
	assert.equal(result.durationSeconds, 610);
	assert.equal(result.passed, false);
});

test("rejects the ten minute boundary and slower runs", () => {
	assert.equal(measureGauntlet(success(600)).passed, false);
	assert.equal(measureGauntlet(success(1600)).passed, false);
});

test("rejects skipped, failed, or absent required delivery jobs", () => {
	for (const conclusion of ["skipped", "failure"]) {
		const input = success(300);
		atIndex(atIndex(input.cd).jobs.jobs).conclusion = conclusion;
		assert.equal(measureGauntlet(input).passed, false);
	}
	const noPublishRequirement = success(300);
	atIndex(noPublishRequirement.requirements).jobs = [
		{ stage: "ci", name: "ci" },
	];
	assert.equal(measureGauntlet(noPublishRequirement).passed, false);
	const absent = success(300);
	atIndex(atIndex(absent.cd).jobs.jobs).name = "another job";
	assert.equal(measureGauntlet(absent).passed, false);
});

test("rejects different commits, incomplete job pages, and absent trigger evidence", () => {
	const mismatch = success(300);
	atIndex(mismatch.cd).run.head_sha = "b".repeat(40);
	assert.equal(measureGauntlet(mismatch).passed, false);
	const tooEarly = success(300);
	atIndex(tooEarly.cd).run.created_at = at(90);
	assert.equal(measureGauntlet(tooEarly).passed, false);
	const incomplete = success(300);
	atIndex(incomplete.cd).jobs.total_count = 2;
	assert.equal(measureGauntlet(incomplete).passed, false);
	const unlinked = success(300);
	delete atIndex(unlinked.cd).event;
	assert.equal(measureGauntlet(unlinked).passed, false);
	const oldAttempt = success(300);
	atIndex(oldAttempt.cd).event!.workflow_run!.run_attempt = 2;
	assert.equal(measureGauntlet(oldAttempt).passed, false);
});

test("does not count unknown cache state as a warm-cache result", () => {
	const input = success(300);
	input.cache = { state: "unknown", evidence: [] };
	assert.equal(measureGauntlet(input).passed, false);
});

test("does not infer public OCI availability from a successful publishing job", () => {
	const input = success(300);
	delete atIndex(input.requirements).publicOci;
	const result = measureGauntlet(input);
	assert.equal(result.passed, false);
	assert.equal(atIndex(result.deployables).publicOciStatus, "unknown");
});

test("rejects a missing layer, digest mismatch, and authenticated-only blob", () => {
	for (const change of ["missing", "mismatch", "authenticated"]) {
		const input = success(300);
		const oci = atIndex(input.requirements).publicOci;
		assert.ok(oci?.blobs);
		if (change === "missing") oci.blobs.pop();
		if (change === "mismatch")
			atIndex(oci.blobs, 1).actualDigest = configDigest;
		if (change === "authenticated") atIndex(oci.blobs, 1).anonymous = false;
		assert.equal(measureGauntlet(input).passed, false);
	}
});

test("requires warm-cache evidence for each deployable", () => {
	const input = success(300);
	delete input.cache.deployables;
	assert.equal(measureGauntlet(input).passed, false);
});

test("reads the triggering workflow event for the current Actions run without logging it", () => {
	const dir = mkdtempSync(join(tmpdir(), "hobo-gauntlet-"));
	try {
		const input = success(300);
		const event = {
			...atIndex(input.cd).event,
			unrelated: "event-payload-must-not-be-logged",
		};
		delete atIndex(input.cd).event;
		const inputPath = join(dir, "input.json");
		const eventPath = join(dir, "event.json");
		writeFileSync(inputPath, JSON.stringify(input));
		writeFileSync(eventPath, JSON.stringify(event));
		const result = spawnSync(
			process.execPath,
			[
				fileURLToPath(
					new URL("../ci/measure-cicd-gauntlet.mts", import.meta.url),
				),
				inputPath,
			],
			{
				env: {
					...process.env,
					GITHUB_EVENT_PATH: eventPath,
					GITHUB_RUN_ID: "2",
				},
				encoding: "utf8",
			},
		);
		assert.equal(result.status, 0);
		assert.equal(JSON.parse(result.stdout).passed, true);
		assert.equal(
			result.stdout.includes("event-payload-must-not-be-logged"),
			false,
		);
		writeFileSync(eventPath, '{"secret":"invalid-payload-must-not-be-logged"');
		const invalid = spawnSync(
			process.execPath,
			[
				fileURLToPath(
					new URL("../ci/measure-cicd-gauntlet.mts", import.meta.url),
				),
				inputPath,
			],
			{
				env: {
					...process.env,
					GITHUB_EVENT_PATH: eventPath,
					GITHUB_RUN_ID: "2",
				},
				encoding: "utf8",
			},
		);
		assert.equal(invalid.status, 2);
		assert.equal(
			invalid.stderr.includes("invalid-payload-must-not-be-logged"),
			false,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("replays the actual failed parent run without inventing cache or trigger evidence", () => {
	const input: GauntletInput = JSON.parse(
		readFileSync(
			new URL(
				"./fixtures/cicd-gauntlet/failed-parent-4a898a8.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const result = measureGauntlet(input);
	assert.equal(result.durationSeconds, 3426);
	assert.equal(result.passed, false);
	assert.equal(result.cache.state, "unknown");
	assert.equal(
		result.deployables.find((entry) => entry.name === "hobo-mcp")?.verified,
		false,
	);
	assert.equal(
		result.deployables.find((entry) => entry.name === "hobo-cli")?.verified,
		false,
	);
});

test("replays the actual green release that skipped publishing", () => {
	const input: GauntletInput = JSON.parse(
		readFileSync(
			new URL(
				"./fixtures/cicd-gauntlet/skipped-release-2eeb84b.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const result = measureGauntlet(input);
	assert.equal(result.durationSeconds, 831);
	assert.equal(result.passed, false);
	assert.equal(
		result.deployables.find((entry) => entry.name === "hobo-sdk")?.verified,
		false,
	);
	assert.ok(
		result.deployables.some((entry) =>
			entry.failures.some((failure) => failure.includes("Missing cd job")),
		),
	);
});

const ociImageType = "application/vnd.oci.image.manifest.v1+json";
const ociIndexType = "application/vnd.oci.image.index.v1+json";
const dockerImageType = "application/vnd.docker.distribution.manifest.v2+json";
const dockerIndexType =
	"application/vnd.docker.distribution.manifest.list.v2+json";

function digestBody(body: string): string {
	return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function childDescriptor(body: string, mediaType: string) {
	return { mediaType, digest: digestBody(body), size: Buffer.byteLength(body) };
}

function multiPlatform() {
	const input = success(300);
	const oci = atIndex(input.requirements).publicOci;
	assert.ok(oci);
	const arm = JSON.stringify({
		schemaVersion: 2,
		mediaType: ociImageType,
		config: { digest: configDigest, size: 17 },
		layers: [{ digest: layerDigest, size: 29 }],
		annotations: { note: "é" },
	});
	const amd = JSON.stringify({
		schemaVersion: 2,
		mediaType: dockerImageType,
		config: { digest: configDigest, size: 17 },
		layers: [{ digest: layerDigest, size: 29 }],
	});
	const attestation = JSON.stringify({
		schemaVersion: 2,
		mediaType: ociImageType,
		config: { digest: configDigest, size: 17 },
		layers: [{ digest: layerDigest, size: 29 }],
		artifactType: "application/vnd.in-toto+json",
	});
	const nested = JSON.stringify({
		schemaVersion: 2,
		mediaType: dockerIndexType,
		manifests: [childDescriptor(amd, dockerImageType)],
	});
	const root = JSON.stringify({
		schemaVersion: 2,
		mediaType: ociIndexType,
		manifests: [
			childDescriptor(arm, ociImageType),
			childDescriptor(nested, dockerIndexType),
			{
				...childDescriptor(attestation, ociImageType),
				annotations: { "vnd.docker.reference.type": "attestation-manifest" },
			},
		],
	});
	oci.manifest = root;
	oci.digest = digestBody(root);
	oci.manifests = [arm, amd, nested, attestation].map((body) => ({
		digest: digestBody(body),
		manifest: body,
		status: 200,
		anonymous: true,
	}));
	return { input, oci, arm, amd, nested, attestation };
}

test("verifies nested OCI and Docker indexes, including attestations", () => {
	assert.equal(measureGauntlet(multiPlatform().input).passed, true);
});

test("rejects missing, tampered, wrong-sized or non-anonymous index evidence", () => {
	for (const change of [
		"missing",
		"tampered",
		"size",
		"private",
		"blob-size",
		"blob-digest",
		"duplicate",
		"attestation",
	] as const) {
		const { input, oci, attestation } = multiPlatform();
		assert.ok(oci.manifests && oci.blobs);
		if (change === "missing") oci.manifests.shift();
		if (change === "tampered") atIndex(oci.manifests).manifest += " ";
		if (change === "size") {
			const document = JSON.parse(oci.manifest ?? "");
			document.manifests[0].size++;
			oci.manifest = JSON.stringify(document);
			oci.digest = digestBody(oci.manifest);
		}
		if (change === "private") atIndex(oci.manifests).anonymous = false;
		if (change === "blob-size") atIndex(oci.blobs).actualSize++;
		if (change === "blob-digest") atIndex(oci.blobs).actualDigest = layerDigest;
		if (change === "duplicate") oci.manifests.push(atIndex(oci.manifests));
		if (change === "attestation")
			oci.manifests = oci.manifests.filter(
				(entry) => entry.digest !== digestBody(attestation),
			);
		assert.equal(measureGauntlet(input).passed, false, change);
	}
});

test("rejects unknown descriptor types, excessive depth, and malformed cycles", () => {
	const unsupported = multiPlatform();
	const doc = JSON.parse(unsupported.oci.manifest ?? "");
	doc.manifests[0].mediaType = "application/unknown";
	unsupported.oci.manifest = JSON.stringify(doc);
	unsupported.oci.digest = digestBody(unsupported.oci.manifest);
	assert.equal(measureGauntlet(unsupported.input).passed, false);

	const deep = success(300);
	const deepOci = atIndex(deep.requirements).publicOci;
	assert.ok(deepOci);
	let child = JSON.stringify({
		schemaVersion: 2,
		mediaType: ociImageType,
		config: { digest: configDigest, size: 17 },
		layers: [{ digest: layerDigest, size: 29 }],
	});
	deepOci.manifests = [
		{
			digest: digestBody(child),
			manifest: child,
			status: 200,
			anonymous: true,
		},
	];
	for (let n = 0; n < 17; n++) {
		child = JSON.stringify({
			schemaVersion: 2,
			mediaType: ociIndexType,
			manifests: [
				childDescriptor(child, n === 0 ? ociImageType : ociIndexType),
			],
		});
		deepOci.manifests.push({
			digest: digestBody(child),
			manifest: child,
			status: 200,
			anonymous: true,
		});
	}
	deepOci.manifest = child;
	deepOci.digest = digestBody(child);
	assert.equal(measureGauntlet(deep).passed, false);

	const cycle = success(300);
	const cycleOci = atIndex(cycle.requirements).publicOci;
	assert.ok(cycleOci);
	const fakeDigest = `sha256:${"c".repeat(64)}`;
	const cyclicBody = JSON.stringify({
		schemaVersion: 2,
		mediaType: ociIndexType,
		manifests: [{ digest: fakeDigest, size: 1, mediaType: ociIndexType }],
	});
	cycleOci.manifest = cyclicBody;
	cycleOci.digest = digestBody(cyclicBody);
	cycleOci.manifests = [
		{ digest: fakeDigest, manifest: cyclicBody, status: 200, anonymous: true },
	];
	assert.equal(measureGauntlet(cycle).passed, false);
});

test("does not treat an attestation-only index as a runnable image", () => {
	const { input, oci, attestation } = multiPlatform();
	const root = JSON.stringify({
		schemaVersion: 2,
		mediaType: ociIndexType,
		manifests: [
			{
				...childDescriptor(attestation, ociImageType),
				annotations: { "vnd.docker.reference.type": "attestation-manifest" },
			},
		],
	});
	oci.manifest = root;
	oci.digest = digestBody(root);
	assert.equal(measureGauntlet(input).passed, false);
});

test("accepts a shared image descriptor in runnable and attestation roles", () => {
	const { input, oci, arm } = multiPlatform();
	const root = JSON.stringify({
		schemaVersion: 2,
		mediaType: ociIndexType,
		manifests: [
			{
				...childDescriptor(arm, ociImageType),
				annotations: { "vnd.docker.reference.type": "attestation-manifest" },
			},
			childDescriptor(arm, ociImageType),
		],
	});
	oci.manifest = root;
	oci.digest = digestBody(root);
	assert.equal(measureGauntlet(input).passed, true);
});

test("rejects malformed evidence and absent descriptor sizes", () => {
	for (const change of ["manifests", "blob", "source", "size"] as const) {
		const { input, oci } = multiPlatform();
		if (change === "manifests") Reflect.set(oci, "manifests", [null]);
		if (change === "blob") Reflect.set(oci, "blobs", [null]);
		if (change === "source") Reflect.set(oci, "evidence", [null]);
		if (change === "size") {
			const root = JSON.parse(oci.manifest ?? "");
			delete root.manifests[0].size;
			oci.manifest = JSON.stringify(root);
			oci.digest = digestBody(oci.manifest);
		}
		assert.doesNotThrow(() => measureGauntlet(input), change);
		assert.equal(measureGauntlet(input).passed, false, change);
	}
});

test("rejects non-string roots and ambiguous image/index documents", () => {
	const malformed = multiPlatform();
	Reflect.set(malformed.oci, "manifest", { schemaVersion: 2 });
	assert.doesNotThrow(() => measureGauntlet(malformed.input));
	assert.equal(measureGauntlet(malformed.input).passed, false);

	const ambiguous = success(300);
	const oci = atIndex(ambiguous.requirements).publicOci;
	assert.ok(oci);
	const body = JSON.stringify({
		schemaVersion: 2,
		config: { digest: configDigest, size: 17 },
		layers: [{ digest: layerDigest, size: 29 }],
		manifests: [],
	});
	oci.manifest = body;
	oci.digest = digestBody(body);
	assert.equal(measureGauntlet(ambiguous).passed, false);
});
