import { createTestRuntime } from "./src/_generated/index.ts";
import { api, resource } from "./app.ts";

const runtime = createTestRuntime({
  app: "{{name}}",
  template: "{{template}}"
});

await runtime.expectResource(resource, "{{resourceName}}");
await runtime.expectHandler(api, "{{route}}");
await runtime.expectResponse(api, {
  path: "{{route}}",
  body: {
    template: "{{template}}"
  }
});
