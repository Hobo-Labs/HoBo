import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	SelectionStrategy,
	SubscriptionKind,
	SubscriptionRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { createGitDriver } from "../../src/sources/drivers/git.js";
import { applyDelta, readPackets } from "../../src/sources/drivers/git-pack.js";
import { gitExchanges, gitFixture } from "./git-fixtures.js";
import {
	clock,
	context,
	FixtureTransport,
	signal,
	type SubscriptionInit,
} from "./support.js";

const { base, commits } = gitFixture;

function sub(extra: SubscriptionInit = {}) {
	return create(SubscriptionRecordSchema, { name: "decl", kind: SubscriptionKind.GIT_REPOSITORY, locator: base, ...extra });
}

async function discover(set: "t1" | "t2" | "t3", subscription: ReturnType<typeof sub>, cursor?: string) {
	const fixture = new FixtureTransport(gitExchanges(set));
	const outcome = await createGitDriver({ http: fixture.http }).discover(
		cursor === undefined ? { source: "web", subscription, signal } : { source: "web", subscription, cursor, signal },
		context(clock().now),
	);
	if (!outcome.ok) throw new Error(JSON.stringify(outcome.reasons));
	expect(fixture.unmatched.map((item) => item.body)).toEqual([]);
	expect(fixture.requests.every((item) => item.method === "GET" || item.headers["git-protocol"] === "version=2")).toBe(true);
	return outcome.value;
}

describe("Git driver (smart HTTP v2, recorded from git upload-pack)", () => {
	it("discovers tags by SemVer with ls-refs peeling and a shallow tree:0 fetch", async () => {
		const result = await discover("t3", sub({ selection: SelectionStrategy.SEMVER }));
		expect(result.artifacts.map((item) => [item.version, item.commit])).toEqual([
			["v1.0.0", commits.c1],
			["v1.1.0", commits.c2],
			["v1.2.0", commits.c3],
		]);
		expect(result.artifacts[2]?.artifact?.coordinate).toBe(`${base}@${commits.c3}`);
		expect(result.artifacts[2]?.artifact?.ecosystem).toBe("git");
		expect(new Set(result.artifacts.map((item) => item.artifact?.digest)).size).toBe(3);
	});

	it("never discovers an older tag after a newer one", async () => {
		const first = await discover("t3", sub({ selection: SelectionStrategy.SEMVER, semverRange: ">=1.2.0" }));
		expect(first.artifacts.map((item) => item.version)).toEqual(["v1.2.0"]);
		const second = await discover("t3", sub({ selection: SelectionStrategy.SEMVER }), first.cursor);
		expect(second.artifacts).toEqual([]);
	});

	it("tracks a branch head, and with a path filter ignores commits that change nothing under it", async () => {
		const filtered = sub({ branch: "main", includePaths: ["deploy"], selection: SelectionStrategy.NEWEST_COMMIT });
		const t1 = await discover("t1", filtered);
		expect(t1.artifacts.map((item) => item.commit)).toEqual([commits.c1]);
		// c2 changes only src/: same declaration, nothing discovered, cursor advances.
		const t2 = await discover("t2", filtered, t1.cursor);
		expect(t2.artifacts).toEqual([]);
		expect(JSON.parse(t2.cursor).at).toBe(commits.c2);
		const t3 = await discover("t3", filtered, t2.cursor);
		expect(t3.artifacts.map((item) => item.commit)).toEqual([commits.c3]);
		expect(t3.artifacts[0]?.artifact?.digest).not.toBe(t1.artifacts[0]?.artifact?.digest);
		// Without the filter, c2 is a new declaration.
		const whole = sub({ branch: "main", selection: SelectionStrategy.NEWEST_COMMIT });
		const w1 = await discover("t1", whole);
		const w2 = await discover("t2", whole, w1.cursor);
		expect(w2.artifacts.map((item) => item.commit)).toEqual([commits.c2]);
	});

	it("does not rediscover the same head", async () => {
		const whole = sub({ branch: "main" });
		const first = await discover("t3", whole);
		const again = await discover("t3", whole, first.cursor);
		expect(again.artifacts).toEqual([]);
	});

	it("refuses a server without protocol v2", async () => {
		const fixture = new FixtureTransport([
			{ url: `${base}/info/refs?service=git-upload-pack`, response: "001e# service=git-upload-pack\n0000" },
		]);
		const outcome = await createGitDriver({ http: fixture.http }).discover({ source: "web", subscription: sub(), signal }, context(clock().now));
		expect(!outcome.ok && outcome.reasons[0]?.code).toBe("source-git-capability-missing");
	});

	it("refuses a non-https locator and a body that is not byte-transparent", async () => {
		const plain = await createGitDriver({ http: new FixtureTransport([]).http }).discover(
			{ source: "web", subscription: sub({ locator: "http://git.example.com/x.git" }), signal },
			context(clock().now),
		);
		expect(!plain.ok && plain.reasons[0]?.code).toBe("source-invalid");
		const fixture = new FixtureTransport([{ url: `${base}/info/refs?service=git-upload-pack`, response: "☃" }]);
		const wide = await createGitDriver({ http: fixture.http }).discover({ source: "web", subscription: sub(), signal }, context(clock().now));
		expect(!wide.ok && wide.reasons[0]?.code).toBe("source-transport-not-binary-safe");
	});

	it("parses pkt-lines and applies copy/insert deltas", () => {
		expect(readPackets(new TextEncoder().encode("0009hello00000001")).map((item) => item.kind)).toEqual(["data", "flush", "delim"]);
		const baseBytes = new TextEncoder().encode("hello world");
		// src 11, dst 9, copy offset 0 size 5, insert " git".
		const delta = new Uint8Array([11, 9, 0x90, 5, 4, 0x20, 0x67, 0x69, 0x74]);
		expect(new TextDecoder().decode(applyDelta(baseBytes, delta))).toBe("hello git");
	});
});
