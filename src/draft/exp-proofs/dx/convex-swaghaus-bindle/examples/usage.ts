import { strict as assert } from "node:assert";
import { bindle } from "@hobo/bindles";
import {
	convexApp,
	convexRootFromAnnotations,
	isConvexWebAppAnnotation,
} from "@hobo/convex";

import {
	authorSwaghausBindle,
	BindleAuthoringParseError,
	draftSwaghausManifest,
	parseSwaghausBindle,
} from "../src/index.ts";
import { type JsonValue } from "../src/json.js";


// Authoring surface: provider-neutral kinds only, no Convex pin on the Bindle.
const definition = bindle((b) => {
	const backend = b.data();
	const auth = b.external({
		endpoints: { workos: "https://api.workos.com" },
	});
	const web = b
		.web(convexApp("examples/convex-swaghaus"))
		.dependsOn(backend, auth);
	return { backend, auth, web };
});

assert.equal(
	convexRootFromAnnotations(definition.resources.web!.annotations),
	"examples/convex-swaghaus",
);
assert.ok(definition.resources.web?.annotations.some(isConvexWebAppAnnotation));
assert.equal(definition.resources.backend?.kind, "data");
assert.equal(definition.resources.auth?.kind, "external");

// The manifest the control plane receives is serialized; parse it once.
const { plan } = authorSwaghausBindle({ root: "examples/convex-swaghaus" });
console.log(
	`plan app=${plan.appName} framework=${plan.framework} root=${plan.webRoot}`,
);
console.log(
	`topology ${[...plan.resources]
		.map((resource) => `${resource.name}:${resource.kind}`)
		.join(" ")}`,
);
console.log(
	`env ${plan.envDeps.map((dep) => `${dep.name}=${dep.routing}`).join(" ")}`,
);

// A provider pin on the Bindle is refused — escapes are Camp/Yard-scoped.
const pinned = draftSwaghausManifest({ root: "examples/convex-swaghaus" });
// SAFETY: `(pinned.resources.web as { annotations: JsonValue[] }).annotations.push({` is required at this I/O or test boundary.
(pinned.resources.web as { annotations: JsonValue[] }).annotations.push({
	provider: "convex",
	option: "deployment",
	config: { region: "us-east" },
});
try {
	parseSwaghausBindle(pinned);
	assert.fail("expected the parser to refuse a provider pin");
} catch (error) {
	assert.ok(error instanceof BindleAuthoringParseError);
	console.log(`refused-pin field=${error.field}`);
}

// Credential material never rides Bindle config (ADR-0027).
const leaky = draftSwaghausManifest({ root: "examples/convex-swaghaus" });
// SAFETY: `(leaky.resources.web as { annotations: JsonValue[] }).annotations.push({` is required at this I/O or test boundary.
(leaky.resources.web as { annotations: JsonValue[] }).annotations.push({
	provider: "hobo",
	option: "webapp",
	config: { deployToken: "prod:swaghaus|deadbeef" },
});
try {
	parseSwaghausBindle(leaky);
	assert.fail("expected the parser to refuse plaintext secret material");
} catch (error) {
	assert.ok(error instanceof BindleAuthoringParseError);
	console.log(`refused-secret reason=${error.reason.split(" —")[0]}`);
}

console.log("convex-swaghaus-bindle:ok");
