bindle("multi-cloud-shop", (b) => {
  const orders = b.database("orders", { engine: "postgres" })
    .with(aws.rds({ multiAz: true }));
  const assets = b.bucket("assets");
  const api = b.compute("api").bind(orders).bind(assets);
  b.compute("frontend").bind(api);
});
