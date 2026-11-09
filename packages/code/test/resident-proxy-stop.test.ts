import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { parseJsonObject } from "../src/json.js";
import { startResidentSshAgentProxy } from "../src/ssh-agent-proxy.js";

// A resident SSH-agent proxy (`_station-agent`) holds a Station session's
// lease, and its launcher stops it with SIGTERM, on which it writes
// pam.SessionEnded(launcher-stop). The launcher sees it as started once its
// socket file exists, which is before the proxy has finished listening. A
// proxy that listened for SIGTERM only after that ended by the signal's
// default action when stopped at once, and wrote nothing.

const PROXY = fileURLToPath(
	new URL("../dist/ssh-agent-proxy.js", import.meta.url),
);

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		await new Promise((resolve) => server.close(resolve));
	}
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("a resident SSH-agent proxy", () => {
	it("stopped as soon as its socket exists, still writes its pam.SessionEnded", async () => {
		const root = mkdtempSync(join(tmpdir(), "r"));
		roots.push(root);
		const upstream = join(root, "a.sock");
		const agent = createServer((socket) => socket.end());
		servers.push(agent);
		await new Promise<void>((resolve) => agent.listen(upstream, resolve));
		// The proxy as hobo-code runs it, its listen widened: the socket file
		// exists half a second before the proxy's listen completes.
		const entry = join(root, "entry.mjs");
		writeFileSync(
			entry,
			`import net from "node:net";
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (path, ready) {
	return listen.call(this, path, () => setTimeout(ready, 500));
};
const { runResidentSshAgentProxy } = await import(${JSON.stringify(PROXY)});
process.exitCode = await runResidentSshAgentProxy(process.argv[3] ?? "");
`,
		);
		const auditPath = join(root, "audit.jsonl");
		const launcher = process.argv[1];
		process.argv[1] = entry;
		try {
			const proxy = await startResidentSshAgentProxy({
				socketPath: join(root, "p.sock"),
				upstreamSocket: upstream,
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
				auditPath,
				stationId: "station:local",
				tenant: "acme",
				sessionId: "pam_test",
				subject: "hobo-code",
				target: "ssh:box",
				isolationClass: "development",
				credentialRef: "tokenref://test",
			});
			await proxy.stop();
		} finally {
			process.argv[1] = launcher ?? "";
		}
		const ended = existsSync(auditPath)
			? readFileSync(auditPath, "utf8")
					.split("\n")
					.filter((line) => line.length > 0)
					.map((line) => parseJsonObject(line))
			: [];
		expect(ended).toEqual([
			expect.objectContaining({
				type: "pam.SessionEnded",
				reason: "launcher-stop",
			}),
		]);
	}, 60_000);
});
