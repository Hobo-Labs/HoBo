import {
	createClaimableOperationKeyDeriver,
	type HttpTransport,
	parseResolveOutcome,
	type ResourceMutationJournal,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import { isJsonObject, type JsonObject, parseJsonObject } from "../src/json.js";
import {
	createNeonManagedPostgresCandidate,
	createNeonManagedPostgresResolver,
	NEON_MANAGED_POSTGRES_PRODUCT_ID,
	type NeonManagedPostgresOptions,
	type NeonManagedProjectIdentity,
	neonManagedPostgres,
	observeNeonManagedPreflight,
} from "../src/managed-postgres.js";

const NOW = 1_795_000_000_000;
const ORG = "org-shiny-bar-70268179";
const limits = {
	activeTimeSeconds: 100_000,
	computeTimeSeconds: 90_000,
	dataTransferBytes: 1_000_000,
	logicalSizeBytes: 2_000_000,
	writtenDataBytes: 3_000_000,
};
const request = {
	ref: {
		slot: "data" as const,
		productId: NEON_MANAGED_POSTGRES_PRODUCT_ID,
		logicalId: "journal",
	},
	credentialRef: "vault://neon/management",
	desired: {
		organizationId: ORG,
		region: "aws-us-east-1",
		quota: limits,
		idempotencyKey: "resource-1",
	},
};

function fixture() {
	type State = { digest: string; status: "uncertain" | "acknowledged" };
	const claims = new Map<string, State>(),
		records = new Map<string, NeonManagedProjectIdentity>(),
		secrets = new Map<string, string>();
	let project: JsonObject | undefined;
	let posts = 0,
		secretWrites = 0,
		probes = 0,
		loseResponse = false,
		failCreateAck = false,
		badHost = false,
		badQuota = false,
		unsafeParameter = false;
	const journal: ResourceMutationJournal &
		NonNullable<NeonManagedPostgresOptions["journal"]> = {
		persistence: "durable-cas",
		async inspect({ mutationId, requestDigest }) {
			const old = claims.get(mutationId);
			if (old && old.digest !== requestDigest)
				throw new Error("mutation digest changed");
			return { status: old?.status ?? "missing" };
		},
		async claim({ mutationId, requestDigest }) {
			const old = claims.get(mutationId);
			if (old && old.digest !== requestDigest)
				throw new Error("mutation digest changed");
			if (old) return { status: old.status };
			claims.set(mutationId, { digest: requestDigest, status: "uncertain" });
			return { status: "claimed" };
		},
		async acknowledge(mutationId, requestDigest) {
			if (failCreateAck && mutationId.endsWith(":create")) {
				failCreateAck = false;
				throw new Error("lost journal acknowledgement");
			}
			claims.set(mutationId, { digest: requestDigest, status: "acknowledged" });
		},
		async uncertain(mutationId, requestDigest) {
			claims.set(mutationId, { digest: requestDigest, status: "uncertain" });
		},
	};
	const options: NeonManagedPostgresOptions = {
		scope: {
			tenantId: "tenant-1",
			providerAccountId: ORG,
			scopeId: "deployment-1",
		},
		deriveOperationKey: createClaimableOperationKeyDeriver(
			Uint8Array.from({ length: 32 }, (_, i) => i + 1),
		),
		journal,
		repository: {
			persistence: "durable-cas",
			async read(key) {
				return records.get(key);
			},
			async create(key, value) {
				const previous = records.get(key);
				if (previous && JSON.stringify(previous) !== JSON.stringify(value))
					throw new Error("different identity");
				records.set(key, value);
			},
		},
		async resolveCredential() {
			return { accountId: ORG, token: "test-management-value" };
		},
		custody: {
			async read(key) {
				const value = secrets.get(key);
				return value === undefined
					? undefined
					: { ref: `vault://neon/${key}`, value };
			},
			async create(key, value) {
				if (secrets.has(key)) throw new Error("immutable key exists");
				secretWrites++;
				secrets.set(key, value);
			},
		},
		async authorize(input) {
			return {
				tenantId: input.scope.tenantId,
				providerAccountId: input.scope.providerAccountId,
				scopeId: input.scope.scopeId,
				logicalId: input.request.ref.logicalId,
				operation: input.operation,
				desiredDigest: input.desiredDigest,
				budgetId: "budget-1",
				quoteRef: "quote-1",
				permissionEvidenceRef: "permission-1",
				quotaEvidenceRef: "quota-1",
				observedAtMs: NOW,
				expiresAtMs: NOW + 180_000,
			};
		},
		async revalidateBeforeWrite() {},
		clock: () => NOW,
		async probeSession(input) {
			probes++;
			expect(input.host).toBe("ep-ready.us-east-1.aws.neon.tech");
			expect(input.database).toBe("hobo_journal");
		},
	};
	const response = (status: number, value: JsonObject) => ({
		status,
		headers: {},
		body: JSON.stringify(value),
	});
	const transport: HttpTransport = async (call) => {
		const url = new URL(call.url),
			path = url.pathname;
		if (call.method === "GET" && path === `/api/v2/organizations/${ORG}`)
			return response(200, { id: ORG, plan: "free" });
		if (call.method === "GET" && path === "/api/v2/projects")
			return response(200, {
				projects: project ? [project] : [],
				pagination: {},
			});
		if (call.method === "POST" && path === "/api/v2/projects") {
			posts++;
			if (!call.body) throw new Error("missing body");
			const body = parseJsonObject(call.body);
			if (!isJsonObject(body.project)) throw new Error("missing project");
			project = {
				...body.project,
				id: "careful-river-12345678",
				owner_id: ORG,
			};
			if (loseResponse) throw new Error("connection dropped");
			return response(201, {
				project,
				branch: {
					id: "br-main-123",
					project_id: project.id,
					name: "main",
					default: true,
				},
				endpoints: [
					{
						id: "ep-ready",
						project_id: project.id,
						branch_id: "br-main-123",
						type: "read_write",
					},
				],
			});
		}
		if (!project) return response(404, {});
		if (path === "/api/v2/projects/careful-river-12345678") {
			const current = badQuota
				? { ...project, settings: { quota: {} } }
				: project;
			return response(200, { project: current });
		}
		if (path.endsWith("/branches/br-main-123"))
			return response(200, {
				branch: {
					id: "br-main-123",
					project_id: project.id,
					name: "main",
					default: true,
				},
			});
		if (path.endsWith("/endpoints/ep-ready"))
			return response(200, {
				endpoint: {
					id: "ep-ready",
					project_id: project.id,
					branch_id: "br-main-123",
					type: "read_write",
					region_id: "aws-us-east-1",
					autoscaling_limit_min_cu: 0.25,
					autoscaling_limit_max_cu: 0.25,
					suspend_timeout_seconds: 300,
					disabled: false,
					host: "ep-ready.us-east-1.aws.neon.tech",
				},
			});
		if (path.endsWith("/databases/hobo_journal"))
			return response(200, {
				database: { name: "hobo_journal", owner_name: "hobo_journal_owner" },
			});
		if (path.endsWith("/connection_uri"))
			return response(200, {
				uri: `postgresql://hobo_journal_owner:fake-value@${badHost ? "evil.example" : "ep-ready.us-east-1.aws.neon.tech"}/hobo_journal?sslmode=require&channel_binding=require${unsafeParameter ? "&host=evil.example" : ""}`,
			});
		throw new Error(`unexpected provider path ${path}`);
	};
	return {
		options,
		transport,
		claims,
		records,
		secrets,
		stats: () => ({ posts, secretWrites, probes }),
		loseResponse: () => {
			loseResponse = true;
		},
		failCreateAck: () => {
			failCreateAck = true;
		},
		badHost: () => {
			badHost = true;
		},
		badQuota: () => {
			badQuota = true;
		},
		unsafeParameter: () => {
			unsafeParameter = true;
		},
		omitOrganizationId: () => {
			if (!project) throw new Error("missing project");
			const { org_id: _, ...other } = project;
			project = other;
		},
		changeOwner: () => {
			if (!project) throw new Error("missing project");
			project = { ...project, owner_id: "org-foreign" };
		},
	};
}

describe("account-owned Neon PostgreSQL", () => {
	it("declares a separate account-bound product and refuses unlimited quotas", () => {
		expect(
			neonManagedPostgres({
				organizationId: ORG,
				region: "aws-us-east-1",
				quota: limits,
			}).productId,
		).toBe(NEON_MANAGED_POSTGRES_PRODUCT_ID);
		expect(() =>
			neonManagedPostgres({
				organizationId: ORG,
				region: "aws-us-east-1",
				quota: { ...limits, computeTimeSeconds: 0 },
			}),
		).toThrow("finite");
		const candidate = createNeonManagedPostgresCandidate({
			evidenceSignatureValid: true,
			evidenceExpiresAtMs: NOW + 60_000,
			secretCustodyAvailable: true,
			conformance: "pass",
		});
		expect(candidate.hasRegisteredDriver).toBe(false);
		expect(candidate.producesBindingProfiles).toEqual([]);
	});
	it("inspects only account metadata and never claims that quota or permissions are ready", async () => {
		const f = fixture();
		const observation = await observeNeonManagedPreflight({
			providerAccountId: ORG,
			credentialRef: request.credentialRef,
			resolveCredential: f.options.resolveCredential,
			transport: f.transport,
			clock: () => NOW,
		});
		expect(observation).toMatchObject({
			providerAccountId: ORG,
			plan: "free",
			activeProjectCount: 0,
			createPermission: "not-observed",
			remainingCapacity: "not-observed",
			quotedCost: "not-observed",
			databaseSession: "not-observed",
		});
		expect(f.stats()).toEqual({ posts: 0, secretWrites: 0, probes: 0 });
	});
	it.each([
		{ unavailable_project_ids: ["careful-river-12345678"] },
		{ pagination: "invalid" },
	])("refuses an incomplete project inventory before planning or creation", async (extra) => {
		const f = fixture();
		const transport: HttpTransport = async (call) => {
			if (
				call.method === "GET" &&
				new URL(call.url).pathname === "/api/v2/projects"
			)
				return {
					status: 200,
					headers: {},
					body: JSON.stringify({ projects: [], ...extra }),
				};
			return f.transport(call);
		};
		await expect(
			observeNeonManagedPreflight({
				providerAccountId: ORG,
				credentialRef: request.credentialRef,
				resolveCredential: f.options.resolveCredential,
				transport,
				clock: () => NOW,
			}),
		).rejects.toThrow("inventory");
		await expect(
			createNeonManagedPostgresResolver(f.options).reconcile(
				request,
				transport,
			),
		).rejects.toThrow("inventory");
		expect(f.stats().posts).toBe(0);
	});
	it("creates once, verifies the direct session and stores only references in the result", async () => {
		const f = fixture(),
			resolver = createNeonManagedPostgresResolver(f.options);
		const first = await resolver.reconcile(request, f.transport);
		expect(first).toMatchObject({
			action: "create",
			physicalId: "careful-river-12345678",
			outputs: {
				providerAccountId: ORG,
				region: "aws-us-east-1",
				ready: false,
				operationConfirmed: true,
				runtimeRoleStatus: "unverified",
			},
		});
		expect(JSON.stringify(first)).not.toContain("fake-value");
		expect(JSON.stringify(first)).not.toContain("test-management-value");
		expect(
			[...f.secrets.values()].some((value) =>
				value.includes("sslmode=verify-full&channel_binding=require"),
			),
		).toBe(true);
		expect(first.outputs.bindingRef).toBeUndefined();
		expect(first.outputs.managementRef).toBeDefined();
		expect(parseResolveOutcome(JSON.parse(JSON.stringify(first)))).toEqual(
			first,
		);
		expect(f.stats()).toEqual({ posts: 1, secretWrites: 1, probes: 1 });
		const again = await createNeonManagedPostgresResolver(f.options).reconcile(
			request,
			f.transport,
		);
		expect(again.physicalId).toBe(first.physicalId);
		expect(f.stats()).toEqual({ posts: 1, secretWrites: 1, probes: 2 });
		const read = await resolver.read?.(request, f.transport);
		expect(read?.outputs.ready).toBe(false);
		expect(read?.outputs.bindingRef).toBeUndefined();
		expect(f.stats().secretWrites).toBe(1);
	});
	it("never repeats an ambiguous create or adopts a project by name alone", async () => {
		const f = fixture();
		f.loseResponse();
		const resolver = createNeonManagedPostgresResolver(f.options);
		await expect(resolver.reconcile(request, f.transport)).rejects.toThrow(
			"uncertain",
		);
		await expect(resolver.reconcile(request, f.transport)).rejects.toThrow(
			"uncertain",
		);
		expect(f.stats()).toEqual({ posts: 1, secretWrites: 0, probes: 0 });
	});
	it("pins the required native owner when the optional organization field is omitted", async () => {
		const f = fixture(),
			resolver = createNeonManagedPostgresResolver(f.options);
		await resolver.reconcile(request, f.transport);
		f.omitOrganizationId();
		expect((await resolver.read?.(request, f.transport))?.physicalId).toBe(
			"careful-river-12345678",
		);
		f.changeOwner();
		await expect(resolver.read?.(request, f.transport)).rejects.toThrow(
			"account",
		);
	});
	it("resumes a recorded successful create after an interrupted journal acknowledgement", async () => {
		const f = fixture();
		f.failCreateAck();
		const resolver = createNeonManagedPostgresResolver(f.options);
		await expect(resolver.reconcile(request, f.transport)).rejects.toThrow(
			"uncertain",
		);
		const result = await createNeonManagedPostgresResolver(f.options).reconcile(
			request,
			f.transport,
		);
		expect(result.outputs.ready).toBe(false);
		expect(result.outputs.operationConfirmed).toBe(true);
		expect(f.stats().posts).toBe(1);
	});
	it("blocks foreign accounts and expired financial authority before creation", async () => {
		const f = fixture();
		const foreign = createNeonManagedPostgresResolver({
			...f.options,
			async resolveCredential() {
				return { accountId: "org-foreign", token: "fake-management-value" };
			},
		});
		await expect(foreign.reconcile(request, f.transport)).rejects.toThrow(
			"different account",
		);
		const expired = createNeonManagedPostgresResolver({
			...f.options,
			async authorize(input) {
				const evidence = await f.options.authorize(input);
				return { ...evidence, expiresAtMs: NOW };
			},
		});
		await expect(expired.reconcile(request, f.transport)).rejects.toThrow(
			"stale",
		);
		expect(f.stats().posts).toBe(0);
	});
	it("rejects changed provider quota or a credential for a different endpoint", async () => {
		const a = fixture();
		await createNeonManagedPostgresResolver(a.options).reconcile(
			request,
			a.transport,
		);
		a.badQuota();
		await expect(
			createNeonManagedPostgresResolver(a.options).reconcile(
				request,
				a.transport,
			),
		).rejects.toThrow("quota");
		const b = fixture();
		b.badHost();
		await expect(
			createNeonManagedPostgresResolver(b.options).reconcile(
				request,
				b.transport,
			),
		).rejects.toThrow("verified direct endpoint");
		expect(b.stats().secretWrites).toBe(0);
		const c = fixture();
		c.unsafeParameter();
		await expect(
			createNeonManagedPostgresResolver(c.options).reconcile(
				request,
				c.transport,
			),
		).rejects.toThrow("verified direct endpoint");
		expect(c.stats().secretWrites).toBe(0);
	});

	it("does not recreate missing or changed custody on a read", async () => {
		const f = fixture(),
			resolver = createNeonManagedPostgresResolver(f.options);
		await resolver.reconcile(request, f.transport);
		f.secrets.clear();
		const observed = await resolver.read?.(request, f.transport);
		expect(observed?.outputs.ready).toBe(false);
		expect(observed?.outputs.managementRef).toBeUndefined();
		expect(f.stats().secretWrites).toBe(1);
	});

	it("stops before any native send when the supervisor no longer authorizes effects", async () => {
		const f = fixture();
		const resolver = createNeonManagedPostgresResolver({
			...f.options,
			async revalidateBeforeWrite() {
				throw new Error("revoked");
			},
		});
		await expect(resolver.reconcile(request, f.transport)).rejects.toThrow(
			"revoked",
		);
		expect(f.stats()).toEqual({ posts: 0, secretWrites: 0, probes: 0 });
		expect(f.claims.size).toBe(0);
	});

	it("holds the create intent when financial evidence expires after its claim", async () => {
		const f = fixture();
		let now = NOW;
		let validations = 0;
		const resolver = createNeonManagedPostgresResolver({
			...f.options,
			clock: () => now,
			async revalidateBeforeWrite() {
				if (++validations === 2) now = NOW + 180_000;
			},
		});
		await expect(resolver.reconcile(request, f.transport)).rejects.toThrow(
			"expired",
		);
		expect(f.stats()).toEqual({ posts: 0, secretWrites: 0, probes: 0 });
		expect([...f.claims.values()]).toEqual([
			expect.objectContaining({ status: "uncertain" }),
		]);
	});

	it("does not publish a credential after approval expires during the session probe", async () => {
		const f = fixture();
		let now = NOW;
		const resolver = createNeonManagedPostgresResolver({
			...f.options,
			clock: () => now,
			async probeSession() {
				now = NOW + 180_000;
			},
		});
		await expect(resolver.reconcile(request, f.transport)).rejects.toThrow(
			"expired",
		);
		expect(f.stats()).toEqual({ posts: 1, secretWrites: 0, probes: 0 });
		expect(f.records.size).toBe(1);
	});

	it("refuses changed custody instead of overwriting a prior credential", async () => {
		const f = fixture(),
			resolver = createNeonManagedPostgresResolver(f.options);
		await resolver.reconcile(request, f.transport);
		const key = [...f.secrets.keys()][0];
		if (!key) throw new Error("fixture has no secret");
		f.secrets.set(key, "different provider secret");
		await expect(resolver.reconcile(request, f.transport)).rejects.toThrow(
			"immutable generation",
		);
		expect(f.stats().posts).toBe(1);
		expect(f.stats().secretWrites).toBe(1);
	});
});
