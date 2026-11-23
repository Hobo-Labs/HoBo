import { registry } from "./rivet-queue-definition.mjs";

if (!registry.config.use.jobs) throw new Error("queue definition is missing");
process.stdout.write("rivet-queue-created-only\n");
