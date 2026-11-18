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

const home = await api.run({ path: "/", method: "GET" });
if (home.status !== 200 || home.headers?.["content-type"] !== "text/html; charset=utf-8" || typeof home.body !== "string" || !home.body.includes("Your first note")) {
  throw new Error("Expected the starter page");
}
const saved = await api.run({ path: "/note", method: "POST", body: "message=Hello+HoBo" });
if (saved.status !== 303 || saved.headers?.location !== "/?saved=1") {
  throw new Error("Expected a redirect after saving");
}
const updated = await api.run({ path: "/?saved=1", method: "GET" });
if (typeof updated.body !== "string" || !updated.body.includes("Hello HoBo") || !updated.body.includes("Note saved.")) {
  throw new Error("Expected the saved note on the page");
}
const invalid = await api.run({ path: "/note", method: "POST", body: "message=+" });
if (invalid.status !== 400) throw new Error("Expected an empty note to be rejected");
