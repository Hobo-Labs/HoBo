import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import {
  HoboWitError,
  assertThinIdiomLayer,
  canonicalJson,
  lowerCanonicalSdkProgram,
  lowerFluentBindle,
  mapTsCancellationToWitResult,
  mapWitResultToTs,
  runAsyncSemanticsAnnex,
  runLoweringConformance,
} from "../src/lowering-contract.js";

const corpusPathLabel = "fixtures/lowering-corpus.json";
const goldenCorpus = JSON.parse(
  await readFile(new URL(`../${corpusPathLabel}`, import.meta.url), "utf8"),
);

test("golden corpus lowers to hobo:sdk calls and byte-identical manifest IR", () => {
  for (const fixture of goldenCorpus) {
    const result = lowerFluentBindle(fixture.fluent);

    assert.deepEqual(result.witCalls, fixture.expectedWitCalls);
    assert.equal(result.manifestJson, canonicalJson(fixture.expectedManifest));
    assert.deepEqual(result.manifest, fixture.expectedManifest);
    assert.equal(result.manifestHash, "sha256:922b120645cb6de843a60c5144f6e266269a904fcb99dd5504addcefc682517f");
  }
});

test("idiom layer source has no cloud/provider behavior imports", async () => {
  const source = await readFile(new URL("../src/lowering-contract.ts", import.meta.url), "utf8");

  assert.deepEqual(assertThinIdiomLayer([{ path: "src/lowering-contract.ts", source }]), []);

  const violations = assertThinIdiomLayer([
    { path: "src/bad.ts", source: 'import { S3Client } from "@aws-sdk/client-s3";\nexport const hiddenDefault = "us-east-1";' },
  ]);
  assert.deepEqual(violations, [
    {
      path: "src/bad.ts",
      reason: "cloud/provider runtime import is not allowed in the idiom layer",
      match: "@aws-sdk/client-s3",
    },
    {
      path: "src/bad.ts",
      reason: "provider default/credential logic is not allowed in the idiom layer",
      match: "us-east-1",
    },
  ]);
});

test("provider .with annotations lower as inert data, not provider behavior", () => {
  const result = lowerFluentBindle({
    bindle: "provider-annotation",
    resources: [
      {
        kind: "service",
        name: "api",
        handler: "./src/api.ts",
        options: [{ provider: "aws", option: "fargate", value: { cpu: 512 } }],
      },
    ],
  });
  const [resource] = result.manifest.resources;

  assert.deepEqual(resource.providerOptions, [
    { provider: "aws", option: "fargate", value: { cpu: 512 } },
  ]);
  assert.equal(resource.provider, undefined);
  assert.equal(resource.resolvedProvider, undefined);
  assert.equal(result.witCalls.some((call) => call.function === "resolve-provider"), false);
});

test("conformance harness reports lowering-equivalence parity for the corpus", () => {
  const report = runLoweringConformance(
    goldenCorpus,
    {
      typescript: (fixture) => lowerFluentBindle(fixture.fluent),
      canonical: (fixture) => lowerCanonicalSdkProgram(fixture.expectedManifest),
    },
    { corpusPath: corpusPathLabel },
  );

  assert.deepEqual(report, {
    suite: "@hobo/conformance/sdk/lowering-equivalence",
    corpusPath: corpusPathLabel,
    status: "passed",
    cases: [{ name: "orders-api", status: "passed" }],
  });
});

test("semantics annex maps WIT result errors to typed TS throws", () => {
  assert.equal(mapWitResultToTs({ ok: "accepted" }), "accepted");

  assert.throws(
    () => mapWitResultToTs({ err: { tag: "deadline-exceeded", message: "step timed out" } }),
    (error) => {
      assert.ok(error instanceof HoboWitError);
      assert.equal(error.tag, "deadline-exceeded");
      assert.equal(error.message, "step timed out");
      return true;
    },
  );
});

test("semantics annex maps TS cancellation into a WIT result without hidden retry behavior", () => {
  assert.deepEqual(
    mapTsCancellationToWitResult({
      reason: "caller-aborted",
      deadlineMs: 250,
    }),
    {
      err: {
        tag: "cancelled",
        message: "caller-aborted",
        deadlineMs: 250,
        retry: "caller-owned",
      },
    },
  );
});

test("async annex preserves awaited order and maps cancellation during async work", async () => {
  await assert.deepEqual(
    await runAsyncSemanticsAnnex([
      { sequence: 2, kind: "handler", resource: "api", event: "http.request" },
      { sequence: 1, kind: "resource", name: "api" },
    ]),
    { ok: ["resource:api", "handler:api:http.request"] },
  );

  await assert.deepEqual(
    await runAsyncSemanticsAnnex([
      { sequence: 1, kind: "resource", name: "api" },
      { sequence: 2, kind: "cancel", reason: "caller-aborted", deadlineMs: 250 },
      { sequence: 3, kind: "handler", resource: "api", event: "http.request" },
    ]),
    {
      err: {
        tag: "cancelled",
        message: "caller-aborted",
        deadlineMs: 250,
        retry: "caller-owned",
      },
      observed: ["resource:api"],
    },
  );

  await assert.rejects(
    () =>
      runAsyncSemanticsAnnex([
        { sequence: 1, kind: "handler", resource: "api", event: "http.request" },
      ]),
    /async IfC order violation: handler api awaited before resource declaration/,
  );
});

test("IfC collection side-effect order is deterministic and hidden defaults fail closed", () => {
  const withoutRetryDefault = lowerFluentBindle({
    bindle: "no-hidden-defaults",
    resources: [{ kind: "service", name: "api", handler: "./src/api.ts" }],
    handlers: [{ resource: "api", event: "http.request", exportName: "handle" }],
    runtime: { steps: [{ name: "checkout", signature: "step(order) -> receipt" }] },
  });

  assert.deepEqual(withoutRetryDefault.manifest.runtime.steps, [
    { name: "checkout", signature: "step(order) -> receipt" },
  ]);
  assert.equal(withoutRetryDefault.manifest.runtime.steps[0].retries, undefined);

  assert.throws(
    () => lowerFluentBindle({
      bindle: "bad-order",
      handlers: [{ resource: "api", event: "http.request", exportName: "handle" }],
      resources: [{ kind: "service", name: "api", handler: "./src/api.ts", collectedAfterHandlers: true }],
    }),
    /IfC collection order violation: handler api must be attached after resource declaration/,
  );
});
