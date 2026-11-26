import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  CDKTF_IMPORT_ONLY_ERROR,
  createCdktfImportOnlyProvider,
  importCdktfState,
  planAdoptedResources,
  readTerraformStateFile,
} from "../src/cdktf-import-only.js";

const fixture = new URL("../fixtures/cdktf-state.json", import.meta.url);
const unknownFixture = new URL("../fixtures/unknown-resource-state.json", import.meta.url);
const malformedFixture = new URL("../fixtures/malformed-state.json", import.meta.url);
const invalidJsonFixture = new URL("../fixtures/invalid-json-state.json", import.meta.url);

describe("@hobo/iac-cdktf import-only backend", () => {
  it("reads a CDKTF/Terraform state fixture into adopted HoBo resource records", async () => {
    const state = await readTerraformStateFile(fixture);
    const imported = importCdktfState(state);

    assert.equal(imported.source, "cdktf");
    assert.equal(imported.mode, "import-only");
    assert.equal(imported.resources.length, 2);
    assert.deepEqual(
      imported.resources.map((resource) => ({
        kind: resource.kind,
        hoboType: resource.hoboType,
        terraformType: resource.terraformType,
        terraformName: resource.terraformName,
        id: resource.id,
      })),
      [
        {
          kind: "adopted",
          hoboType: "objectStore",
          terraformType: "aws_s3_bucket",
          terraformName: "assets",
          id: "gallery-assets-prod",
        },
        {
          kind: "adopted",
          hoboType: "database",
          terraformType: "aws_dynamodb_table",
          terraformName: "sessions",
          id: "gallery-sessions-prod",
        },
      ],
    );
    assert.deepEqual(imported.resources[0].provenance, {
      source: "cdktf",
      stateLineage: "cdktf-fixture-lineage",
      stateSerial: 27,
      provider: "registry.terraform.io/hashicorp/aws",
      address: "aws_s3_bucket.assets",
    });
    assert.deepEqual(imported.portabilityReport.nonPortableSurface, [
      {
        resource: "aws_s3_bucket.assets",
        kind: "adopted",
        reason: "brownfield resource adopted from CDKTF/Terraform state",
      },
      {
        resource: "aws_dynamodb_table.sessions",
        kind: "adopted",
        reason: "brownfield resource adopted from CDKTF/Terraform state",
      },
    ]);
  });

  it("rejects apply, preview, and destroy with a precise import-only error", async () => {
    const provider = createCdktfImportOnlyProvider();

    for (const operation of ["apply", "preview", "destroy"]) {
      await assert.rejects(() => provider[operation]({}), {
        name: "CdktfImportOnlyError",
        code: CDKTF_IMPORT_ONLY_ERROR,
        message: `@hobo/iac-cdktf is import-only: ${operation} would author infrastructure`,
      });
    }
  });

  it("passes the import -> plan -> no-op diff conformance path without destroy/recreate", async () => {
    const provider = createCdktfImportOnlyProvider();
    const report = await provider.refresh({ stateFile: fixture });
    const plan = planAdoptedResources(report.resources);

    assert.equal(report.kind, "drift-report");
    assert.equal(report.provider, "cdktf");
    assert.equal(report.drifted, false);
    assert.deepEqual(plan.diff, {
      dirty: false,
      changes: [],
      reason: "adopted resources are drift-detect only",
    });
    assert.deepEqual(plan.blockedAuthoringChanges, []);
  });

  it("surfaces unmapped resource types as external resources instead of dropping them", async () => {
    const imported = importCdktfState(await readTerraformStateFile(unknownFixture));

    assert.equal(imported.resources.length, 1);
    assert.deepEqual(imported.resources[0], {
      kind: "external",
      hoboType: "external",
      terraformType: "stripe_product",
      terraformName: "premium_plan",
      address: "stripe_product.premium_plan",
      id: "prod_123",
      provider: "registry.terraform.io/stripe/stripe",
      attributes: {
        id: "prod_123",
        name: "Premium",
      },
      provenance: {
        source: "cdktf",
        stateLineage: undefined,
        stateSerial: undefined,
        provider: "registry.terraform.io/stripe/stripe",
        address: "stripe_product.premium_plan",
      },
      externalReason: "no HoBo mapping for Terraform resource type stripe_product",
    });
  });

  it("blocks a plan that would destroy or recreate adopted resources", async () => {
    const imported = importCdktfState(await readTerraformStateFile(fixture));

    assert.throws(
      () =>
        planAdoptedResources(imported.resources, {
          proposedChanges: [
            { op: "delete", resource: "aws_s3_bucket.assets" },
            { op: "create", resource: "aws_s3_bucket.assets" },
          ],
        }),
      {
        name: "CdktfImportOnlyError",
        code: "destructive-import-plan",
        message: /CDKTF import is drift-detect only: refusing delete, create for aws_s3_bucket\.assets/,
      },
    );
  });

  it("fails closed on malformed or partial state files", async () => {
    await assert.rejects(() => readTerraformStateFile(invalidJsonFixture), {
      name: "CdktfStateError",
      code: "malformed-state-json",
      message: /malformed CDKTF\/Terraform state JSON/,
    });

    await assert.rejects(() => readTerraformStateFile(malformedFixture), {
      name: "CdktfStateError",
      code: "missing-resource-id",
      message: /aws_s3_bucket\.broken instance 0 is missing attributes\.id/,
    });

    assert.throws(
      () => importCdktfState({ version: 4 }),
      {
        name: "CdktfStateError",
        code: "missing-resources",
        message: /must contain resources\[\]/,
      },
    );
  });
});
