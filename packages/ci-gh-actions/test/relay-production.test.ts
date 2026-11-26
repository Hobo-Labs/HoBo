import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clone } from "@bufbuild/protobuf";
import { ConfigurationSchema } from "@hobo/ci";
import { afterEach, expect, it } from "vitest";
import { harness, NOW, queued, reserve, signed } from "./fixtures.js";

const instances: ReturnType<typeof harness>[] = [];
const directories: string[] = [];
function setup(path?: string) {
	const h = harness(path);
	instances.push(h);
	return h;
}
afterEach(() => {
	for (const h of instances.splice(0)) {
		h.store.close();
		expect(h.api.violations).toEqual([]);
	}
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
function connection(h: ReturnType<typeof harness>) {
	const current = h.relay.options.config.connections[0];
	if (!current) throw new Error("test connection missing");
	return current;
}
function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

it.each([
	"installation",
	"removed",
	"branch",
	"event",
	"public",
])("rechecks %s authority after REST awaits before reserving or persisting demand", async (change) => {
	const h = setup();
	if (change === "public") connection(h).publicRepositoryAcknowledged = true;
	h.store.configure(h.configuration, 0, NOW);
	const entered = deferred();
	const gate = deferred();
	const send = h.api.request.bind(h.api);
	h.api.request = async (installation, path, method = "GET", body) => {
		if (path === "/repos/org/repo/actions/runs/11") {
			entered.resolve();
			await gate.promise;
		}
		return send(installation, path, method, body);
	};
	const payload = signed(queued());
	const pending = h.relay.webhook(
		payload.body,
		payload.signature,
		"workflow_job",
	);
	await entered.promise;
	try {
		const next = clone(ConfigurationSchema, h.configuration);
		const updated = next.connections[0];
		if (!updated) throw new Error("test connection missing");
		if (change === "installation") {
			updated.installationId = 11;
			updated.bridgeSha = "b".repeat(40);
		}
		if (change === "removed") next.connections = [];
		if (change === "branch") updated.allowedRefs = ["refs/heads/new-trusted"];
		if (change === "event") updated.allowedEvents = ["workflow_dispatch"];
		if (change === "public") h.api.original.repository.private = false;
		const state = h.store.configure(next, 1, NOW);
		if (!state.configuration) throw new Error("committed policy missing");
		h.relay.options.config = state.configuration;
	} finally {
		gate.resolve();
	}
	expect(await pending).toBe("ignored");
	expect(h.store.all()).toEqual([]);
	expect(h.store.pendingJobs()).toEqual([]);
	expect(
		h.store.events().some((event) => event.type === "ci.LeaseReserved"),
	).toBe(false);
	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(0);
	expect(h.store.configure(h.configuration, 2, NOW).revision).toBe(3);
});

it("refuses an acknowledged public repository even for a trusted push", async () => {
	const h = setup();
	connection(h).publicRepositoryAcknowledged = true;
	h.api.original.repository.private = false;
	const payload = signed(queued());
	expect(
		await h.relay.webhook(payload.body, payload.signature, "workflow_job"),
	).toBe("ignored");
	await h.relay.dispatchPending();
	expect(h.store.all()).toEqual([]);
	expect(h.api.dispatches).toBe(0);
	expect(h.api.registrations).toBe(0);
});

it("cancels before dispatch if an opted-in repository becomes public after reservation", async () => {
	const h = setup();
	connection(h).publicRepositoryAcknowledged = true;
	const lease = await reserve(h);
	h.api.original.repository.private = false;
	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(0);
	expect(h.store.get(lease.id)?.state).toBe("cancelled");
});

it("refuses JIT if an opted-in repository becomes public after host dispatch", async () => {
	const h = setup();
	connection(h).publicRepositoryAcknowledged = true;
	const lease = await reserve(h);
	await h.relay.dispatchPending();
	h.api.original.repository.private = false;
	h.api.host.repository.private = false;
	await expect(h.relay.claim(lease.id, "valid")).rejects.toThrow(
		/authority revoked/,
	);
	expect(h.api.registrations).toBe(0);
});

it.each([
	"opt-out",
	"fork",
	"event",
	"ref",
])("public repository intake refuses %s without bypassing original trust controls", async (condition) => {
	const h = setup();
	connection(h).publicRepositoryAcknowledged = condition !== "opt-out";
	h.api.original.repository.private = false;
	if (condition === "fork") h.api.original.head_repository.id = 999;
	if (condition === "event") h.api.original.event = "pull_request";
	if (condition === "ref") h.api.original.head_branch = "untrusted";
	const payload = signed(queued());
	expect(
		await h.relay.webhook(payload.body, payload.signature, "workflow_job"),
	).toBe("ignored");
	expect(h.store.all()).toEqual([]);
	expect(h.store.pendingJobs()).toEqual([]);
	expect(h.api.dispatches).toBe(0);
});

it("refuses a public host without opt-in even when its original run was private", async () => {
	const h = setup();
	const lease = await reserve(h);
	await h.relay.dispatchPending();
	h.api.host.repository = { id: 101, private: false };
	await expect(h.relay.claim(lease.id, "valid")).rejects.toThrow(
		/untrusted host/,
	);
	expect(h.api.registrations).toBe(0);
	h.api.host.status = "completed";
	await expect(h.relay.reconcile(lease.id, 22)).rejects.toThrow(/completion/);
	expect(h.store.get(lease.id)?.state).toBe("dispatched");
});

const firstPage =
	"/repos/org/repo/actions/workflows/host.yml/runs?event=workflow_dispatch&per_page=100";
function unrelatedRuns(page: number) {
	return Array.from({ length: 100 }, (_, index) => ({
		id: page * 1000 + index,
		display_title: `other host ${page}-${index}`,
	}));
}

it("discovers page-two host completion after disk reopen and preserves settlement on replay", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-relay-discovery-"));
	directories.push(directory);
	const database = join(directory, "relay.sqlite");
	const before = setup(database);
	const lease = await reserve(before);
	before.api.uncertain = true;
	await before.relay.dispatchPending();
	expect(before.store.get(lease.id)?.state).toBe("uncertain");
	before.store.close();
	instances.splice(instances.indexOf(before), 1);
	expect(before.api.violations).toEqual([]);
	const h = setup(database);
	h.api.host.display_title = `HoBo lease ${lease.id}`;
	h.api.host.status = "completed";
	h.api.jobStatus = "completed";
	const paths: string[] = [];
	const send = h.api.request.bind(h.api);
	h.api.request = async (installation, path, method = "GET", body) => {
		paths.push(path);
		if (path === firstPage || path === `${firstPage}&page=2`) {
			expect(installation).toBe(10);
			expect(method).toBe("GET");
			return Response.json({
				workflow_runs:
					path === firstPage
						? unrelatedRuns(1)
						: [{ id: 22, display_title: h.api.host.display_title }],
			});
		}
		return send(installation, path, method, body);
	};
	await h.relay.discover(lease.id);
	expect(paths).toEqual([
		firstPage,
		`${firstPage}&page=2`,
		"/repos/org/repo/actions/runs/22",
		"/repos/org/repo/actions/runs/22/jobs",
		"/repos/org/repo/actions/jobs/1",
	]);
	expect(h.store.get(lease.id)).toMatchObject({
		state: "completed",
		hostRunId: 22,
		billedMinutes: 1,
	});
	h.store.rebuild();
	expect(h.store.get(lease.id)).toMatchObject({
		state: "completed",
		hostRunId: 22,
		billedMinutes: 1,
	});
	expect(
		h.store.events().filter((event) => event.type === "ci.HostSettled"),
	).toHaveLength(1);
});

it("retains uncertain reservations when matching host titles span multiple discovery pages", async () => {
	const h = setup();
	const lease = await reserve(h);
	h.api.uncertain = true;
	await h.relay.dispatchPending();
	const send = h.api.request.bind(h.api);
	const pages: string[] = [];
	h.api.request = async (installation, path, method = "GET", body) => {
		if (path.startsWith(firstPage)) {
			pages.push(path);
			return Response.json({
				workflow_runs:
					path === firstPage
						? [
								{ id: 22, display_title: h.api.host.display_title },
								...unrelatedRuns(1).slice(0, 99),
							]
						: [{ id: 23, display_title: h.api.host.display_title }],
			});
		}
		return send(installation, path, method, body);
	};
	await expect(h.relay.discover(lease.id)).rejects.toThrow(/ambiguous/);
	expect(pages).toEqual([firstPage, `${firstPage}&page=2`]);
	expect(h.store.get(lease.id)?.state).toBe("uncertain");
	expect(
		h.store.events().some((event) => event.type === "ci.HostSettled"),
	).toBe(false);
});

it("bounds discovery at ten full pages and retains the reservation for operator reconciliation", async () => {
	const h = setup();
	const lease = await reserve(h);
	h.api.uncertain = true;
	await h.relay.dispatchPending();
	const send = h.api.request.bind(h.api);
	const pages: string[] = [];
	h.api.request = async (installation, path, method = "GET", body) => {
		if (path.startsWith(firstPage)) {
			pages.push(path);
			return Response.json({ workflow_runs: unrelatedRuns(pages.length) });
		}
		return send(installation, path, method, body);
	};
	await expect(h.relay.discover(lease.id)).rejects.toThrow(/window exhausted/);
	expect(pages).toHaveLength(10);
	expect(pages[0]).toBe(firstPage);
	expect(pages.at(-1)).toBe(`${firstPage}&page=10`);
	expect(h.store.get(lease.id)?.state).toBe("uncertain");
	expect(
		h.store.events().some((event) => event.type === "ci.HostSettled"),
	).toBe(false);
});

it.each([
	"branch",
	"event",
])("does not dispatch after %s authority is revoked during GitHub reads", async (change) => {
	const h = setup();
	connection(h).allowedRefs.push("refs/heads/other");
	connection(h).allowedEvents.push("workflow_dispatch");
	h.store.configure(h.configuration, 0, NOW);
	const lease = await reserve(h);
	const entered = deferred();
	const gate = deferred();
	const send = h.api.request.bind(h.api);
	h.api.request = async (installation, path, method = "GET", body) => {
		if (path === "/repos/org/repo/actions/runs/11") {
			entered.resolve();
			await gate.promise;
		}
		return send(installation, path, method, body);
	};
	const dispatch = h.relay.dispatchPending();
	await entered.promise;
	try {
		const next = clone(ConfigurationSchema, h.configuration);
		const updated = next.connections[0];
		if (!updated) throw new Error("fixture connection");
		if (change === "branch") updated.allowedRefs = ["refs/heads/other"];
		if (change === "event") updated.allowedEvents = ["workflow_dispatch"];
		const state = h.store.configure(next, 1, NOW);
		if (!state.configuration) throw new Error("fixture configuration");
		h.relay.options.config = state.configuration;
	} finally {
		gate.resolve();
	}
	await dispatch;
	expect(h.api.dispatches).toBe(0);
	expect(h.store.get(lease.id)?.state).toBe("cancelled");
});

it.each([
	"branch",
	"event",
])("does not issue JIT after %s authority is revoked during host checks", async (change) => {
	const h = setup();
	connection(h).allowedRefs.push("refs/heads/other");
	connection(h).allowedEvents.push("workflow_dispatch");
	h.store.configure(h.configuration, 0, NOW);
	const lease = await reserve(h);
	await h.relay.dispatchPending();
	const entered = deferred();
	const gate = deferred();
	const send = h.api.request.bind(h.api);
	h.api.request = async (installation, path, method = "GET", body) => {
		if (path === "/repos/org/repo/actions/runs/22/jobs") {
			entered.resolve();
			await gate.promise;
		}
		return send(installation, path, method, body);
	};
	const claim = h.relay.claim(lease.id, "valid");
	const rejected = expect(claim).rejects.toThrow(/authority revoked/);
	await entered.promise;
	try {
		const next = clone(ConfigurationSchema, h.configuration);
		const updated = next.connections[0];
		if (!updated) throw new Error("fixture connection");
		if (change === "branch") updated.allowedRefs = ["refs/heads/other"];
		if (change === "event") updated.allowedEvents = ["workflow_dispatch"];
		const state = h.store.configure(next, 1, NOW);
		if (!state.configuration) throw new Error("fixture configuration");
		h.relay.options.config = state.configuration;
	} finally {
		gate.resolve();
	}
	await rejected;
	expect(h.api.registrations).toBe(0);
	expect(h.store.get(lease.id)?.state).toBe("dispatched");
});
