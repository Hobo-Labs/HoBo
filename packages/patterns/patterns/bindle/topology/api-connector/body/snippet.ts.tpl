export default bindle("{{resourceName}}", (b) => {
  const crawl = b.connector(firecrawl);
  const api = b.api(() => researchApi).dependsOn(crawl);
  return { crawl, api };
});
