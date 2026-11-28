import { createServer } from "node:http";

import type { CommandRunInput, PrepareInput } from "@hobo/cli";
import { expect, it } from "vitest";

import { prepareGithubConnection } from "../src/prepare.js";

it("routes the CI store probe, signed in with the handed-over Connect token, through the configured egress proxy", async () => {
	let connects = 0;
	const proxy = createServer();
	proxy.on("connect", (_request, socket) => {
		connects += 1;
		socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
	});
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	const address = proxy.address();
	if (!address || !(address instanceof Object))
		throw new Error("proxy did not bind");
	try {
		// SAFETY: preparation reads only progress and these output flags.
		const input: PrepareInput = {
			action: "up",
			projectDir: "/box/project",
			cwd: "/box/project",
			whatIf: false,
			yes: false,
			handOff: true,
			run: {
				emitProgress: () => undefined,
				flags: { json: false, quiet: false },
			} as CommandRunInput,
		};
		await prepareGithubConnection(input, {
			env: {
				HOBO_SECRET_STORE: "1password",
				OP_VAULT_ID: "k2l3m4n5o6p7q8r9s0t1u2v3w4",
				OP_CONNECT_HOST: "https://127.0.0.1:44449",
				HTTPS_PROXY: `http://127.0.0.1:${address.port}`,
			},
			locator: { read: async () => ({}), write: async () => undefined },
			ownerChannel: {
				openUrl: async () => undefined,
				captureSecret: async ({ name }) =>
					name === "OP_CONNECT_TOKEN"
						? "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJob2JvIn0.c2lnbmF0dXJl"
						: undefined,
				holds: (name) => name === "OP_CONNECT_TOKEN",
			},
		});
		expect(connects).toBeGreaterThan(0);
	} finally {
		proxy.closeAllConnections();
		await new Promise<void>((resolve) => proxy.close(() => resolve()));
	}
});
