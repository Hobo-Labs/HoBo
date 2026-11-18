import { registry } from "./rivet-topic-definition.mjs";

// Alchemy bundles and runs this file as the pool's program. setup() alone only
// constructs the registry; start() connects the actor to the Rivet engine.
registry.start();

// Signal the test only after RivetKit confirms the envoy is ready.
const deadline = Date.now() + 30_000;
let ready = false;
while (Date.now() < deadline) {
	const response = await registry.routes.health();
	if (response.ok) {
		ready = true;
		process.stdout.write("rivet-topic-pool-ready\n");
		break;
	}
	await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!ready) throw new Error("Rivet topic pool did not start");
