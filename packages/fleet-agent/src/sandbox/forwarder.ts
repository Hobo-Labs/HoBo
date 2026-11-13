/**
 * The forwarder: a small Node program the OCI driver runs as a second
 * container beside the workload (D58), never in the host's namespaces. Its
 * root file system is the host's `/`, read-only, so the host's own `node` and
 * C library run unchanged; the per-sandbox socket directory is its only other
 * mount. Under gVisor's `runsc` it is a container in the workload's pod and
 * shares the sentry's loopback-only network stack; under an operator's host
 * `runc` or `crun` it joins the workload's network namespace by path. It runs
 * as a uid the workload cannot signal, in a pid namespace of its own.
 *
 * For each route it listens on `127.0.0.1:<port>` in that network and pipes
 * every connection to a Unix socket the agent serves: one route to the
 * per-sandbox relay of the order's egress proxy, one to the sandbox's control
 * endpoint. Nothing else in that network can reach the host, and no other
 * sandbox has a listener on these ports, so `controlUrl` answers only from
 * inside its own sandbox.
 *
 * It prints `ready` once every route listens, and exits when its standard
 * input closes, so it never outlives the agent. Its argv carries ports and
 * socket paths only, never a secret.
 */

// public-contract: the line the forwarder prints once all its routes listen.
export const FORWARDER_READY = "ready";

/** Program text for `node -e`; its one argument is the JSON array of routes. */
// public-contract: the forwarder program the OCI driver runs as the forwarder container's process; its argv and ready line are its interface.
export const FORWARDER_SCRIPT = `
const net = require("node:net");
const routes = JSON.parse(process.argv[1]);
let listening = 0;
for (const route of routes) {
	const server = net.createServer({ allowHalfOpen: true }, (client) => {
		const upstream = net.connect(route.socket);
		client.on("error", () => upstream.destroy());
		upstream.on("error", () => client.destroy());
		client.pipe(upstream);
		upstream.pipe(client);
	});
	server.on("error", (error) => {
		process.stderr.write(String(error) + "\\n");
		process.exit(1);
	});
	server.listen(route.port, "127.0.0.1", () => {
		listening += 1;
		if (listening === routes.length) process.stdout.write("${FORWARDER_READY}\\n");
	});
}
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
process.stdin.resume();
`;

export type ForwardRoute = Readonly<{ port: number; socket: string }>;
