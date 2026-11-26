import type { PactRequest, PactResponse } from "../../../src/index.js";
import type { ProviderStub } from "../../../src/verify.js";
import { isJsonObject } from "../../../src/json.js";


export const skewedProviderStub: ProviderStub = {
  name: "CoreContractSurface",
  handle(request: PactRequest): PactResponse {
    const schemaVersion = isJsonObject(request.body) ? request.body.schemaVersion : undefined;

    if (schemaVersion === "hobo.core/v0") {
      return {
        status: 400,
        body: {
          error: {
            code: "HOBO_CORE_UNSUPPORTED_SCHEMA",
            message: "unsupported schemaVersion",
          },
        },
      };
    }

    return {
      status: 200,
      body: {
        schemaVersion: "hobo.core/v2",
        eventMappings: { cloudEventSpecversion: "1.0" },
        publicSurface: { ok: true },
        surfaceHash: "static-reference",
      },
    };
  },
};
