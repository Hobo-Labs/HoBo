// Runs the shell host's `/sessions serve --host box` forward against a real
// Station, its authorization's lease ending LEASE_MS from now, then blocks
// this process's event loop for BLOCK_MS: the forward's own lease timer
// cannot run, as in a shell that hangs. Used by test/shell-forward.test.ts.
import { existsSync } from "node:fs";
import { openStationGateway } from "../../dist/machine-sessions.js";
import { createDefaultShellHost } from "../../dist/shell-host.js";

const { HOBO_HOME, PROJECT, AGENT_SOCKET, SSH_PID, LEASE_MS, BLOCK_MS } =
	process.env;
const host = createDefaultShellHost({
	hoboHome: HOBO_HOME,
	cwd: PROJECT,
	env: { PATH: process.env.PATH, HOBO_HOME },
	openStationGateway: async (context) => {
		const gateway = await openStationGateway({
			...context,
			sshAuthSock: AGENT_SOCKET,
		});
		return {
			...gateway,
			broker: {
				registerTarget: (target) => gateway.broker.registerTarget(target),
				brokerSession: async (request) => ({
					...(await gateway.broker.brokerSession(request)),
					expiresAt: new Date(Date.now() + Number(LEASE_MS)).toISOString(),
				}),
			},
		};
	},
});
await host.runVerb([
	"session",
	"serve",
	"--host",
	"box",
	"--port",
	"4242",
	"--station",
	"station:local",
]);
while (!existsSync(SSH_PID)) await new Promise((r) => setTimeout(r, 50));
const end = Date.now() + Number(BLOCK_MS);
while (Date.now() < end) {
	// The shell hangs: no timer, no event.
}
process.exit(0);
