import { bindle } from "@hobo/bindles";

export default bindle("{{resourceName}}", (b) => {
  const api = b.api(() => apiHandler);
  const web = b.web(() => webHandler).dependsOn(api);
  return { api, web };
});
