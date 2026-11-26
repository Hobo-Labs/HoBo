// The recorded Git smart-HTTP v2 exchanges (fixtures/git.json, produced by
// fixtures/generate-git.ts from a real git upload-pack).
import gitFixture from "./fixtures/git.json" with { type: "json" };
import type { Exchange } from "./support.js";

export { gitFixture };

/** Recorded exchanges for one moment of the fixture repository (t1, t2, t3). */
export function gitExchanges(set: "t1" | "t2" | "t3"): readonly Exchange[] {
	return gitFixture.sets[set].map((item): Exchange => {
		const response = Buffer.from(item.response, "base64").toString("latin1");
		return "body" in item && item.body !== undefined
			? { method: item.method, url: item.url, body: item.body, response }
			: { method: item.method, url: item.url, response };
	});
}
