import { config, env, secretRef } from "../bindles/schema.js";

export const cfg = config({
  GREETING: env("hello"),
  LOG_LEVEL: env("info"),
  API_KEY: secretRef("hello/api-key"),
});
