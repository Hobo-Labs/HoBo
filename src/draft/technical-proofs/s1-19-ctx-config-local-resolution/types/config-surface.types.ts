import { config, env, fromBinding, secretRef } from "../src/bindles/schema.js";
import { createConfigContext } from "../src/runtime/context.js";

const cfg = config({
  DB: fromBinding("db"),
  STRIPE: secretRef("stripe/api-key"),
  LOG_LEVEL: env("info"),
});

const ctx = createConfigContext(cfg, {
  resolve: async () => "resolved",
});

const stripe: Promise<string> = ctx.config.STRIPE();
const db: Promise<string> = ctx.config.DB();
const logLevel: Promise<string> = ctx.config.LOG_LEVEL();

void stripe;
void db;
void logLevel;

// @ts-expect-error undeclared config keys must not be callable.
ctx.config.MISSING();
