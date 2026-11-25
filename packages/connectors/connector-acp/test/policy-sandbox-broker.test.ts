import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	buildConnectorTokenRequest,
	classifyActionClass,
	evaluateToolPermission,
	parseAgentGuardrailPolicy,
	parseSandboxPosture,
	SANDBOX_POSTURE_SCHEMA,
	scrubEnvironment,
} from "../src/index.js";

const POLICY = parseAgentGuardrailPolicy({
	agentId: "swe-agent-1",
	actionClasses: {
		read: "auto-allow",
		destroy: "deny",
	},
	allowedApprovers: ["tyler"],
});

describe("policy gate (deny-ceiling, fail closed)", () => {
	it("classifies toward the stricter class: unknown verbs are write, never read", () => {
		assert.equal(classifyActionClass("logs:tail"), "read");
		assert.equal(classifyActionClass("resource.delete:db"), "destroy");
		assert.equal(classifyActionClass("deployment:apply x"), "deploy");
		assert.equal(classifyActionClass("mint-token"), "token");
		assert.equal(classifyActionClass("something-novel"), "write");
	});

	it("unlisted action classes parse to require-approval, never allow", () => {
		// write/deploy/token/admin were omitted from the policy document.
		assert.equal(POLICY.actionClasses.write, "require-approval");
		assert.equal(POLICY.actionClasses.deploy, "require-approval");
	});

	it("require-approval without an allowed approver resolves to deny", () => {
		const missing = evaluateToolPermission({
			action: "deployment:apply shop",
			policy: POLICY,
		});
		assert.equal(missing.effect, "deny");

		const wrongApprover = evaluateToolPermission({
			action: "deployment:apply shop",
			policy: POLICY,
			approval: { approver: "mallory" },
		});
		assert.equal(wrongApprover.effect, "deny");
		assert.ok(wrongApprover.reasons.includes("approver-not-allowed"));

		const approved = evaluateToolPermission({
			action: "deployment:apply shop",
			policy: POLICY,
			approval: { approver: "tyler" },
		});
		assert.equal(approved.effect, "allow");
	});

	it("rejects malformed policy documents instead of defaulting open", () => {
		assert.throws(() => parseAgentGuardrailPolicy({ agentId: "" }));
		assert.throws(() =>
			parseAgentGuardrailPolicy({
				agentId: "a",
				actionClasses: { destroy: "allow-always" },
			}),
		);
	});
});

describe("sandbox posture (s3-07 guardrails)", () => {
	const posture = {
		schema: SANDBOX_POSTURE_SCHEMA,
		ambientCredentials: false,
		filesystem: { scope: "workspace", root: "/workspace/shop" },
		network: { scope: "allowlist", allowlist: ["api.anthropic.com"] },
		envAllowlist: ["PATH", "HOME"],
	};

	it("parses the fail-closed posture and scrubs the environment to the allowlist", () => {
		const parsed = parseSandboxPosture(posture);
		assert.equal(parsed.ambientCredentials, false);
		const scrubbed = scrubEnvironment(parsed, {
			PATH: "/usr/bin",
			HOME: "/home/agent",
			AWS_SECRET_ACCESS_KEY: "leaky",
			GITHUB_TOKEN: "leaky",
		});
		assert.deepEqual(scrubbed, { PATH: "/usr/bin", HOME: "/home/agent" });
	});

	it("rejects ambient credentials and open egress", () => {
		assert.throws(() =>
			parseSandboxPosture({ ...posture, ambientCredentials: true }),
		);
		assert.throws(() =>
			parseSandboxPosture({
				...posture,
				network: { scope: "open" },
			}),
		);
		assert.throws(() =>
			parseSandboxPosture({
				...posture,
				filesystem: { scope: "host", root: "/" },
			}),
		);
	});
});

describe("connector-token broker seam (ai-native-agent-auth.md)", () => {
	const principal = {
		kind: "agent" as const,
		id: "swe-agent-1",
		svid: "spiffe://hobo.local/agent/swe-agent-1",
		delegatedBy: { kind: "user" as const, id: "tyler" },
	};

	it("builds an SVID-bound, user-delegated exchange request that can only narrow scopes", () => {
		const request = buildConnectorTokenRequest({
			requestId: "xaa-swe-agent",
			principal,
			target: { id: "swe-agent", audience: "acp://swe-agent" },
			manifestAllow: ["logs:tail", "deployments:apply"],
			requestedScopes: ["logs:tail"],
		});
		assert.deepEqual([...request.requestedScopes], ["logs:tail"]);
		assert.equal(request.subject.svid, principal.svid);
	});

	it("refuses widening and non-delegated principals", () => {
		assert.throws(() =>
			buildConnectorTokenRequest({
				requestId: "xaa-swe-agent",
				principal,
				target: { id: "swe-agent", audience: "acp://swe-agent" },
				manifestAllow: ["logs:tail"],
				requestedScopes: ["logs:tail", "admin:all"],
			}),
		);
		assert.throws(() =>
			buildConnectorTokenRequest({
				requestId: "xaa-swe-agent",
				// SAFETY: assertion to `undefined as never` is required at this boundary.
				principal: { ...principal, delegatedBy: undefined as never },
				target: { id: "swe-agent", audience: "acp://swe-agent" },
				manifestAllow: ["logs:tail"],
			}),
		);
	});
});
