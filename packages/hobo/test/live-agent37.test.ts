import type { OwnerChannel } from "@hobo/hobo-ci";
import { machineRunner, whichOnPath } from "@hobo/hobo-ci";
import {
	AGENT37_API_KEY_REF,
	createAgent37ClientFromCredentials,
} from "@hobo/provider-agent37";
import { afterAll, describe, expect, it } from "vitest";

import {
	createOwnerStoreSessions,
	ownerChannelSignIn,
} from "../src/owner-store-session.js";

const owner: OwnerChannel = {
	async openUrl(url, message) {
		process.stderr.write(`${message}\n${url}\n`);
	},
	async captureSecret() {
		return undefined;
	},
	holds() {
		return false;
	},
};

const sessions = createOwnerStoreSessions({
	signIn: ownerChannelSignIn({
		owner,
		deps: {
			runCommand: machineRunner(),
			which: (bin) => whichOnPath(bin),
		},
	}),
});
const cwd = process.cwd();
const established = await sessions.establish(cwd);

afterAll(() => sessions.close());

describe.skipIf(established.status !== "established")(
	`Agent37 live read-only smoke (needs ${AGENT37_API_KEY_REF} in the owner's store session: run HoBo MCP's choose_secret_store first)`,
	() => {
		it("lists instances with the key from the owner's store", async () => {
			const client = await createAgent37ClientFromCredentials({
				credentials: sessions.credentials(cwd),
				fetchImpl: globalThis.fetch,
			});
			const instances = await client.listInstances();
			expect(Array.isArray(instances)).toBe(true);
		}, 30_000);
	},
);
