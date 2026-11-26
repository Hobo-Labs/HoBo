import { createHobo, create{{runtimeName}}Store } from "./src/_generated/index.ts";

const hobo = createHobo({
  name: "{{name}}",
  template: "{{template}}"
});

export const resource = hobo.resource("{{resourceName}}", create{{runtimeName}}Store());

export const api = hobo.api("{{route}}", async (request) => {
  const record = await resource.put("{{seedKey}}", {
    message: "{{message}}"
  });

  return {
    status: 200,
    body: {
      template: "{{template}}",
      path: request.path,
      record
    }
  };
});
