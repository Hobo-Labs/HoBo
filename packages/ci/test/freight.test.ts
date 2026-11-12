import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { LeaseSchema, PipelineResultSchema } from "../src/_generated/ci_pb.js";
import {
	CI_FREIGHT_MANIFEST_SCHEMA,
	CI_FREIGHT_REASON,
	type CiBuild,
	CiFreightError,
	ciFreightCoordinate,
	ciFreightManifest,
	ciFreightOutputs,
	ciFreightPipelineArtifacts,
	ciProvenanceStatement,
	HOBO_DELIVERABLES,
	IN_TOTO_STATEMENT_TYPE,
	SLSA_PROVENANCE_PREDICATE,
	writeCiFreightManifest,
} from "../src/freight.js";
import { runCiFreightCli } from "../src/freight-cli.js";

const sha = (bytes: Uint8Array | string) =>
	createHash("sha256").update(bytes).digest("hex");

const build: CiBuild = {
	repository: "Hobo-Labs/HoBo",
	commit: "0123456789abcdef0123456789abcdef01234567",
	ref: "refs/heads/main",
	pipeline: "hobo-main",
	runId: "4242-1",
	ciSystem: "github-actions",
	builderId: "https://github.com/Hobo-Labs/HoBo/.github/workflows/hobo-ci.yml",
};

const golden = readFileSync(
	join(import.meta.dirname, "fixtures", "relay-freight-manifest.json"),
	"utf8",
);

describe("HoBo's own deliverables as Freight", () => {
	it("names the relay and runner outputs the HOBO_CI Freight sources read", () => {
		expect(HOBO_DELIVERABLES.relay).toMatchObject({
			bindle: "hobo-ci-relay",
			output: "relay/bundle",
			kind: "ARTIFACT_KIND_FUNCTION_BUNDLE",
		});
		expect(HOBO_DELIVERABLES.runnerImage).toMatchObject({
			bindle: "hobo-ci-runner-fleet",
			output: "runner-fleet/image",
			kind: "ARTIFACT_KIND_OCI_IMAGE",
			ecosystem: "oci",
		});
		expect(Object.keys(HOBO_DELIVERABLES).sort()).toEqual([
			"cli",
			"relay",
			"runnerImage",
			"sdk",
			"site",
		]);
	});

	it("writes the same canonical hobo.freight-manifest/v1 bytes @hobo/cd writes", () => {
		// The fixture is @hobo/cd's writeFreightManifest output for this input;
		// @hobo/ci cannot import @hobo/cd (cd -> stations -> ci would cycle).
		const bundle = new TextEncoder().encode("relay bundle bytes");
		const statement = ciProvenanceStatement(build, [
			{ name: "relay/bundle", digest: `sha256:${sha(bundle)}` },
		]);
		const manifest = ciFreightManifest({
			deliverable: HOBO_DELIVERABLES.relay,
			digest: `sha256:${sha(bundle)}`,
			sizeBytes: bundle.byteLength,
			build,
			provenance: statement,
		});
		expect(new TextDecoder().decode(writeCiFreightManifest(manifest))).toBe(
			golden.trim(),
		);
	});

	it("refuses a manifest whose artifact digest is not sha256", () => {
		const manifest = ciFreightManifest({
			deliverable: HOBO_DELIVERABLES.sdk,
			digest: "md5:abc",
			sizeBytes: 1,
			build,
		});
		let refusal: unknown;
		try {
			writeCiFreightManifest(manifest);
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeInstanceOf(CiFreightError);
		expect((refusal as CiFreightError).reasons[0]).toMatchObject({
			code: CI_FREIGHT_REASON.manifestInvalid,
			subject: "artifacts[0].digest",
		});
	});

	it("refuses credential material in a source field instead of redacting it", () => {
		const manifest = ciFreightManifest({
			deliverable: HOBO_DELIVERABLES.sdk,
			digest: `sha256:${sha("x")}`,
			sizeBytes: 1,
			build: {
				...build,
				repository: "https://user:hunter2@example.com/hobo.git",
			},
		});
		expect(() => writeCiFreightManifest(manifest)).toThrow(CiFreightError);
		try {
			writeCiFreightManifest(manifest);
		} catch (error) {
			expect((error as CiFreightError).reasons[0]?.code).toBe(
				CI_FREIGHT_REASON.secretInRecord,
			);
		}
	});

	it("records provenance as an in-toto v1 statement with an SLSA v1 predicate over every subject", () => {
		const subjects = [
			{ name: "sdk/tarball", digest: `sha256:${sha("b")}` },
			{ name: "cli/tarball", digest: `sha256:${sha("a")}` },
		];
		const provenance = ciProvenanceStatement(build, subjects);
		const statement = JSON.parse(new TextDecoder().decode(provenance.bytes));
		expect(statement._type).toBe(IN_TOTO_STATEMENT_TYPE);
		expect(statement.predicateType).toBe(SLSA_PROVENANCE_PREDICATE);
		expect(statement.subject).toEqual([
			{ name: "cli/tarball", digest: { sha256: sha("a") } },
			{ name: "sdk/tarball", digest: { sha256: sha("b") } },
		]);
		expect(statement.predicate.runDetails.builder.id).toBe(build.builderId);
		expect(
			statement.predicate.buildDefinition.resolvedDependencies[0].digest,
		).toEqual({ gitCommit: build.commit });
		expect(provenance.digest).toBe(`sha256:${sha(provenance.bytes)}`);
		// Unsigned: CD records the reference but never counts it as verified.
		expect(provenance.ref).toMatchObject({ verified: false, verifier: "" });
	});

	it("gives each deliverable its bytes, its manifest and the run's statement as CI outputs", () => {
		const runner = new TextEncoder().encode('{"schemaVersion":2}');
		const site = new TextEncoder().encode("site tar");
		const result = ciFreightOutputs(build, [
			{ id: "runnerImage", bytes: runner },
			{ id: "site", bytes: site },
		]);
		const paths = result.outputs.map((output) => output.path);
		expect(paths).toEqual([
			"freight/provenance.intoto.json",
			"runner-fleet/image",
			"runner-fleet/image.freight.json",
			"site/bundle",
			"site/bundle.freight.json",
		]);
		for (const output of result.outputs)
			expect(output.sha256).toBe(sha(output.bytes));
		const manifest = JSON.parse(
			new TextDecoder().decode(
				result.outputs.find(
					(output) => output.path === "runner-fleet/image.freight.json",
				)?.bytes,
			),
		);
		expect(manifest.schemaVersion).toBe(CI_FREIGHT_MANIFEST_SCHEMA);
		expect(manifest.bindle).toBe("hobo-ci-runner-fleet");
		expect(manifest.artifacts[0]).toMatchObject({
			digest: `sha256:${sha(runner)}`,
			coordinate: ciFreightCoordinate(build, "runner-fleet/image"),
		});
		expect(manifest.provenance[0].statementDigest).toBe(
			`sha256:${result.outputs[0]?.sha256}`,
		);
		expect(result.manifests.map((item) => item.bindle)).toEqual([
			"hobo-ci-runner-fleet",
			"hobo-site",
		]);
	});

	it("refuses an unknown deliverable rather than inventing a Bindle for it", () => {
		expect(() =>
			ciFreightOutputs(build, [{ id: "docs", bytes: new Uint8Array(1) }]),
		).toThrow(/unknown HoBo deliverable docs/);
	});

	it("puts the outputs in a passing PipelineResult the HOBO_CI reader verifies by re-reading", async () => {
		const bundle = new TextEncoder().encode("relay bundle bytes");
		const artifacts = await ciFreightPipelineArtifacts(build, [
			{ id: "relay", bytes: bundle },
		]);
		const lease = create(LeaseSchema, {
			pipelineId: build.pipeline,
			repository: build.repository,
			result: create(PipelineResultSchema, {
				id: build.runId,
				status: "passed",
				artifacts,
			}),
		});
		// The structural read @hobo/cd's CiEventReader driver makes (I15):
		// match by path, then hash the bytes it reads back.
		const json = toJson(LeaseSchema, lease) as {
			pipelineId: string;
			result: {
				status: string;
				artifacts: { path: string; sha256: string; data: string }[];
			};
		};
		expect(json.pipelineId).toBe("hobo-main");
		expect(json.result.status).toBe("passed");
		const relay = json.result.artifacts.find(
			(item) => item.path === "relay/bundle",
		);
		expect(relay?.sha256).toBe(sha(bundle));
		expect(sha(Buffer.from(relay?.data ?? "", "base64"))).toBe(relay?.sha256);
		expect(json.result.artifacts.map((item) => item.path)).toContain(
			"relay/bundle.freight.json",
		);
	});

	it("refuses an output over the pipeline artifact limit instead of truncating it", async () => {
		await expect(
			ciFreightPipelineArtifacts(build, [
				{ id: "cli", bytes: new Uint8Array(1024 * 1024 + 1) },
			]),
		).rejects.toThrow(/one MiB/);
	});

	it("refuses a build without a commit: Freight is bound to one commit", () => {
		expect(() =>
			ciFreightOutputs({ ...build, commit: "main" }, [
				{ id: "sdk", bytes: new Uint8Array(1) },
			]),
		).toThrow(CiFreightError);
	});
});

describe("the freight CLI the HoBo CI Fabric workflow calls", () => {
	function workspace() {
		const dir = mkdtempSync(join(tmpdir(), "hobo-ci-freight-"));
		const sdk = join(dir, "sdk.tgz");
		writeFileSync(sdk, "sdk tarball");
		return { dir, sdk, out: join(dir, "out") };
	}
	const args = (out: string) => [
		"--out",
		out,
		"--repository",
		build.repository,
		"--commit",
		build.commit,
		"--ref",
		build.ref,
		"--pipeline",
		build.pipeline,
		"--run-id",
		build.runId,
		"--ci-system",
		build.ciSystem,
		"--builder-id",
		build.builderId,
	];

	it("writes the outputs and ci-result.json, and names every deliverable it did not build", async () => {
		const { sdk, out, dir } = workspace();
		const lines: string[] = [];
		const githubOutput = join(dir, "github-output");
		writeFileSync(githubOutput, "");
		const code = await runCiFreightCli(
			[...args(out), "--deliverable", `sdk=${sdk}`],
			{ write: (text) => lines.push(text), githubOutput },
		);
		expect(code).toBe(0);
		const result = JSON.parse(
			readFileSync(join(out, "ci-result.json"), "utf8"),
		);
		expect(result).toMatchObject({
			pipelineId: build.pipeline,
			repository: build.repository,
			headSha: build.commit,
			result: { id: build.runId, status: "passed" },
		});
		const sdkOutput = result.result.artifacts.find(
			(item: { path: string }) => item.path === "sdk/tarball",
		);
		expect(sdkOutput.sha256).toBe(sha("sdk tarball"));
		expect(readFileSync(join(out, "sdk", "tarball"), "utf8")).toBe(
			"sdk tarball",
		);
		const text = lines.join("");
		for (const skipped of ["cli", "relay", "runnerImage", "site"])
			expect(text).toContain(`skipped ${skipped}: not built by this run`);
		const outputs = readFileSync(githubOutput, "utf8");
		expect(outputs).toContain(`ci-result=${join(out, "ci-result.json")}`);
		expect(outputs).toContain('freight-bindles=["hobo-sdk"]');
	});

	it("exits 2 on an unknown deliverable id", async () => {
		const { sdk, out } = workspace();
		const lines: string[] = [];
		const code = await runCiFreightCli(
			[...args(out), "--deliverable", `docs=${sdk}`],
			{ write: (text) => lines.push(text) },
		);
		expect(code).toBe(2);
		expect(lines.join("")).toMatch(/unknown HoBo deliverable docs/);
	});

	it("exits 2 and writes nothing when no deliverable was built", async () => {
		const { out } = workspace();
		const lines: string[] = [];
		const code = await runCiFreightCli(args(out), {
			write: (text) => lines.push(text),
		});
		expect(code).toBe(2);
		expect(lines.join("")).toMatch(/no deliverable/);
	});
});
