import { registry } from "./rivet-queue-definition.mjs";

registry.start();

const deadline = Date.now() + 30_000;
let ready = false;
while (Date.now() < deadline) {
	const response = await registry.routes.health();
	if (response.ok) {
		ready = true;
		process.stdout.write("rivet-queue-pool-ready\n");
		break;
	}
	await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!ready) throw new Error("Rivet queue pool did not start");
