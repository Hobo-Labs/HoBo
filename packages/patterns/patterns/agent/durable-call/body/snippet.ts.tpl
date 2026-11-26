  const token = await ctx.step("mint-broker-token", () => ctx.token({ provider: "acme-cloud", scope: "database:write" }));
