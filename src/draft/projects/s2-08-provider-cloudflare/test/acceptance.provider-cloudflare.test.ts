import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { hoboVerify, runProviderCapabilitySuites } from "../../../technical-proofs/provider-capability-conformance-suites/src/provider-capability-conformance.js";
import { validateEmission } from "../../../technical-proofs/hobo-realize-emission-contract/src/realize-emission-contract.js";
import {
  CLOUDFLARE_PROVIDER_ID,
  CLOUDFLARE_TERRAFORM_DRIVER,
  CLOUDFLARE_WRANGLER_DRIVER,
  cloudflare,
  createCloudflareProvider,
  evaluateCloudflarePlan,
  realizeCloudflarePlan,
  simulateCloudflareApply,
} from "../../../technical-proofs/provider-cloudflare-contract/src/provider-cloudflare.js";
import { createHelloBindlePlan, createProviderCloudflareDraft } from "../src/index.js";

describe("BDD: Platform engineer registers Cloudflare provider-owned defaults", () => {
  it("Given a Cloudflare factory, When capability manifest is published, Then web/service, kv, and objectStore ports are advertised", () => {
    const draft = createProviderCloudflareDraft();
    const capabilities = JSON.parse(draft.publishedManifest["/.well-known/capability-manifest/capabilities.json"]);

    assert.equal(draft.id, CLOUDFLARE_PROVIDER_ID);
    assert.deepEqual(
      capabilities.capabilities.map((c: { port: string }) => c.port).sort(),
      ["compute", "kv", "objectStore"],
    );
    assert.equal(draft.coversInitialPort("web/service"), true);
    assert.equal(draft.coversInitialPort("kv"), true);
    assert.equal(draft.coversInitialPort("objectStore"), true);
  });

  it("Given scoped .with builders, When only Cloudflare options are merged, Then foreign provider options are dropped", () => {
    const provider = createCloudflareProvider();
    const plan = createHelloBindlePlan();
    plan.resources[0].options = [
      cloudflare.with.worker({ cpuMs: 15_000 }),
      { providerId: "aws", port: "compute", optionName: "fargate", options: { cpu: 2 } },
    ];
    const emission = realizeCloudflarePlan(provider, plan);
    const worker = emission.iac.nodes.find((node) => node.id === "service");

    assert.equal(worker?.inputs.options.cpuMs, 15_000);
    assert.equal(emission.provider, CLOUDFLARE_PROVIDER_ID);
  });
});

describe("BDD: Application developer realizes hello-bindle through Cloudflare", () => {
  it("Given hello-bindle plan, When realize runs, Then Worker, R2, and KV nodes emit with correct drivers", () => {
    const provider = createCloudflareProvider();
    const emission = realizeCloudflarePlan(provider, createHelloBindlePlan());
    const validation = validateEmission(emission);

    assert.equal(validation.ok, true);
    assert.deepEqual(
      emission.iac.nodes.map((node) => [node.id, node.resourceClass, node.driverIntent.iacProvider]),
      [
        ["service", "cloudflare:workers-script", CLOUDFLARE_WRANGLER_DRIVER],
        ["assets", "cloudflare:r2-bucket", CLOUDFLARE_TERRAFORM_DRIVER],
        ["sessions", "cloudflare:kv-namespace", CLOUDFLARE_TERRAFORM_DRIVER],
      ],
    );
    assert.equal(emission.build?.artifacts[0]?.id, "hello-bindle-wasm");
    assert.equal(emission.iac.links.length, 2);
  });
});

describe("BDD: Maintainer runs provider-capability conformance", () => {
  it("Given local+camp tags, When conformance suites run for initial ports, Then provider passes with explicit kv evidence", () => {
    const provider = createCloudflareProvider({ campEvidence: "pass" });
    const capabilities = ["compute", "objectStore"];
    const report = runProviderCapabilitySuites(provider, { capabilities, tags: ["local", "camp"] });
    const verify = hoboVerify(provider, {
      capabilities,
      runTags: ["local", "camp"],
      claimProdReady: true,
    });
    const kv = provider.verifyKvEvidence({ tags: ["local", "camp"] });

    assert.equal(report.status, "pass");
    assert.equal(verify.status, "pass");
    assert.equal(kv.status, "pass");
  });
});

describe("Adversarial: capability gaps reject with precise reasons", () => {
  it("rejects strict S3 semantics on R2 objectStore", () => {
    const provider = createCloudflareProvider();
    const result = evaluateCloudflarePlan(provider, {
      ...createHelloBindlePlan(),
      resources: [
        {
          id: "assets",
          type: "objectStore",
          className: "bucket",
          require: ["durable", "s3-etag-md5", "s3-read-after-overwrite"],
        },
      ],
    });

    assert.equal(result.type, "deployment.PlanRejected");
    assert.equal(result.reason?.code, "cloudflare-r2-s3-compat-divergence");
  });

  it("rejects Worker CPU limits exceeded", () => {
    const provider = createCloudflareProvider();
    const plan = createHelloBindlePlan();
    plan.resources[0].options = [cloudflare.with.worker({ cpuMs: 60_000 })];
    const result = evaluateCloudflarePlan(provider, plan);

    assert.equal(result.type, "deployment.PlanRejected");
    assert.equal(result.reason?.code, "cloudflare-worker-limit-exceeded");
  });

  it("rejects account quota exhaustion before apply", () => {
    const provider = createCloudflareProvider();
    const evaluation = evaluateCloudflarePlan(provider, createHelloBindlePlan());
    assert.equal(evaluation.type, "deployment.Planned");

    const result = simulateCloudflareApply(provider, createHelloBindlePlan(), {
      accountQuota: { compute: 0 },
    });

    assert.equal(result.type, "deployment.PlanRejected");
    assert.equal(result.reason?.code, "cloudflare-account-quota-exhausted");
  });
});
