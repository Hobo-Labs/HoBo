// public-contract: the line the forwarder prints once all its routes listen.
export const FORWARDER_READY = "ready";

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
