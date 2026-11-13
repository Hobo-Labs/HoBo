/**
 * The forwarder: a small Node program the OCI driver starts inside a
 * sandbox's network namespace (with `nsenter --net`), while it stays in the
 * host's mount namespace. For each route it listens on `127.0.0.1:<port>` in
 * that namespace and pipes every connection to a Unix socket on the host: one
 * route to the per-sandbox relay of the order's egress proxy, one to the
 * sandbox's control endpoint. Nothing else in that namespace can reach the
 * host, and no other sandbox has a listener on these ports, so `controlUrl`
 * answers only from inside its own sandbox.
 *
 * It prints `ready` once every route listens, and exits when its standard
 * input closes, so it never outlives the agent. Its argv carries ports and
 * socket paths only, never a secret.
 */

// public-contract: the line the forwarder prints once all its routes listen.
export const FORWARDER_READY = "ready";

/** Program text for `node -e`; its one argument is the JSON array of routes. */
// public-contract: the forwarder program the OCI driver runs with nsenter; its argv and ready line are its interface.
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
