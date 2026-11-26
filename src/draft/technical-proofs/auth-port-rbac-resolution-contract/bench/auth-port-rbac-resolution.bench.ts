import { bench, describe } from "vitest";

import {
	BUILT_IN_ROLES,
	bindScimGroupToRole,
	createAuthPortRbacResolver,
	createAuthPortSnapshot,
	grantAction,
} from "../src/auth-port-rbac-resolution.ts";

const resolver = createAuthPortRbacResolver({
	bindings: [bindScimGroupToRole({ groupId: "scim:org-admins", roleId: BUILT_IN_ROLES.ORG_ADMIN })],
});
const snapshot = createAuthPortSnapshot({
	principal: { kind: "user", id: "user:alice" },
	auth: { adapter: "workos", scimGroups: ["scim:org-admins"], snapshotSeq: "auth-snapshot:1" },
});

// Numbers are advisory; the gate only requires that declared benches EXECUTE.
describe("auth-port RBAC resolution hot path", () => {
	bench("resolveSubject (scim groups -> roles)", () => {
		resolver.resolveSubject(snapshot);
	});

	bench("authorize (cached subject + grant match)", () => {
		resolver.authorize(snapshot, grantAction("role", "bind"));
	});

	bench("createAuthPortSnapshot (parse boundary)", () => {
		createAuthPortSnapshot({
			principal: { kind: "user", id: "user:alice" },
			auth: { adapter: "workos", scimGroups: ["scim:org-admins"], snapshotSeq: "auth-snapshot:1" },
		});
	});
});
