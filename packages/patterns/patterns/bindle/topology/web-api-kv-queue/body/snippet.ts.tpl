export default bindle("{{resourceName}}", (b) => {
  const products = b.kv().allow("get", "set");
  const orders = b.queue().allow("enqueue");
  const api = b.api(() => shopApi).dependsOn(products, orders);
  const web = b.web(() => storefront).dependsOn(api);
  return { products, orders, api, web };
});
