import { bindle } from "../../src/closure-builder-resource-handles.ts";

const myApi = {
  run() {
    return undefined;
  },
};

const shop = bindle("shop", (b) => {
  const cache = b.cache();
  const queue = b.queue<{ orderId: string }>();
  const api = b.api(() => myApi.run()).dependsOn(cache, queue);

  // @ts-expect-error v1 builder factories do not accept explicit resource names.
  b.cache("cache");

  // @ts-expect-error v1 has dependsOn(), not uses().
  api.uses(cache);

  return { cache, queue, api };
});

shop.aliases.api.dependsOn(shop.aliases.cache);
