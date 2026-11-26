import { buildClosureBuilderAuthorFlow } from "../../src/closure-builder-author-flow.ts";

const flow = buildClosureBuilderAuthorFlow();

flow.aliases.api.dependsOn(flow.aliases.cache, flow.aliases.orders);

// @ts-expect-error generated aliases expose the returned authoring keys only.
void flow.aliases.db;

// @ts-expect-error aliases are not generated resource IDs.
const generatedId: "res_api_0001" = flow.aliases.api;

const apiId: "res_api_0001" = flow.identity.generatedIds.api;
const cacheId: "res_cache_0001" = flow.identity.generatedIds.cache;
const ordersId: "res_queue_0001" = flow.identity.generatedIds.orders;

void [apiId, cacheId, ordersId, generatedId];
