import {
  bindle,
  resourceIdentityDiagnostics,
  type BindleManifest,
  type ResourceHandle,
} from "../../closure-builder-resource-handles-contract/src/closure-builder-resource-handles.ts";
import {
  lowerClosureBuilderGraph,
  type ClosureBuilderLoweringInput,
  type ClosureBuilderLoweringResult,
} from "../../closure-builder-manifest-lowering-contract/src/closure-builder-manifest-lowering.ts";

export const CLOSURE_BUILDER_AUTHOR_FLOW_CORPUS_PATH =
  "src/draft/technical-proofs/closure-builder-author-flow-contract/src/closure-builder-author-flow.ts#buildClosureBuilderAuthorFlow";

export interface OrderEvent {
  readonly orderId: string;
}

export interface ClosureBuilderAuthorFlow {
  readonly name: "snapshop-cache-api-orders";
  readonly aliases: {
    readonly cache: ResourceHandle<"cache">;
    readonly orders: ResourceHandle<"queue">;
    readonly api: ResourceHandle<"api">;
  };
  readonly identity: {
    readonly generatedIds: {
      readonly cache: "res_cache_0001";
      readonly orders: "res_queue_0001";
      readonly api: "res_api_0001";
    };
  };
  readonly identityDiagnostics: ReturnType<typeof resourceIdentityDiagnostics>;
  readonly collected: BindleManifest<ClosureBuilderAuthorFlow["aliases"]>;
  readonly loweringInput: ClosureBuilderLoweringInput;
  readonly lowered: ClosureBuilderLoweringResult;
}

const myApi = {
  run() {
    return undefined;
  },
};

export function buildClosureBuilderAuthorFlow(): ClosureBuilderAuthorFlow {
  const collected = bindle("snapshop", (b) => {
    const cache = b.cache();
    const orders = b.queue<OrderEvent>();
    const api = b.api(() => myApi.run()).dependsOn(cache, orders);

    return { cache, orders, api };
  });
  const loweringInput = toLoweringInput(collected);

  return {
    name: "snapshop-cache-api-orders",
    aliases: collected.aliases,
    identity: {
      generatedIds: {
        cache: "res_cache_0001",
        orders: "res_queue_0001",
        api: "res_api_0001",
      },
    },
    identityDiagnostics: resourceIdentityDiagnostics(collected),
    collected,
    loweringInput,
    lowered: lowerClosureBuilderGraph(loweringInput),
  };
}

export function runClosureBuilderAuthorFlowConformance() {
  const flow = buildClosureBuilderAuthorFlow();
  const passed =
    flow.lowered.manifest.schema === "hobo.manifest/v1" &&
    flow.lowered.manifest.relationships.length === 2 &&
    flow.lowered.manifest.authoringAliases.api === "res_api_0001" &&
    flow.identityDiagnostics.every((diagnostic) => diagnostic.alias !== diagnostic.generatedId);

  return {
    suite: "@hobo/conformance/sdk/closure-builder-author-flow",
    corpusPath: CLOSURE_BUILDER_AUTHOR_FLOW_CORPUS_PATH,
    status: passed ? "passed" : "failed",
    cases: [{ name: flow.name, status: passed ? "passed" : "failed" }],
  };
}

function toLoweringInput(
  collected: BindleManifest<ClosureBuilderAuthorFlow["aliases"]>,
): ClosureBuilderLoweringInput {
  return {
    bindleName: collected.name,
    resources: collected.resources.map((resource) => ({
      generatedId: resource.generatedId,
      kind: resource.kind,
      workload: resource.workload
        ? {
            kind: resource.workload.kind,
            entrypoint: "myApi.run",
          }
        : undefined,
    })),
    aliases: Object.entries(collected.aliases).map(([alias, handle]) => ({
      alias,
      generatedId: handle.generatedId,
    })),
    relationships: collected.relationships,
  };
}
