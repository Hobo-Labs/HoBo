import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDashboardRoute } from "../../src/index.js";
import { type PactReadApi, pactReadApi } from "./pact-read-api.js";

export type LocalDashboard = Readonly<{
	origin: string;
	api: PactReadApi;
	close: () => Promise<void>;
}>;

export async function serveDashboard(): Promise<LocalDashboard> {
	const dashboard = createDashboardRoute();
	const api = pactReadApi();
	const server: Server = createServer((incoming, outgoing) => {
		const request = new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
			method: incoming.method ?? "GET",
			headers: Object.entries(incoming.headers).flatMap(
				([name, value]): [string, string][] =>
					value === undefined ? [] : [[name, String(value)]],
			),
		});
		void (async () => {
			const answer =
				(await dashboard(request)) ??
				(await api.handle(request)) ??
				new Response("not found", { status: 404 });
			outgoing.writeHead(answer.status, Object.fromEntries(answer.headers));
			outgoing.end(Buffer.from(await answer.arrayBuffer()));
		})();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!listeningOnPort(address))
		throw new Error("the dashboard test server has no port");
	const { port } = address;
	return {
		origin: `http://127.0.0.1:${port}`,
		api,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}

function listeningOnPort(
	address: AddressInfo | string | null,
): address is AddressInfo {
	return address instanceof Object;
}
