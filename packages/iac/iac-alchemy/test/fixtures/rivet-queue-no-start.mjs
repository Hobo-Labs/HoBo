import { registry } from "./rivet-queue-definition.mjs";

// Negative control: importing setup() creates a registry but starts no envoy.
if (!registry.config.use.jobs) throw new Error("queue definition is missing");
process.stdout.write("rivet-queue-created-only\n");
