// Regenerate the rendered-document goldens after an intentional change:
// `node --import tsx test/write-golden.ts` from packages/cd-gitops; review the diff.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPublication } from "../src/index.js";
import { config, resolved, set } from "./fixtures.js";

const out = join(dirname(fileURLToPath(import.meta.url)), "golden");
mkdirSync(out, { recursive: true });
const argo = renderPublication(config("GITOPS_ENGINE_ARGO_CD"), set, resolved);
const flux = renderPublication(config("GITOPS_ENGINE_FLUX"), set, resolved);
writeFileSync(
	join(out, "argo-cd.application.json.golden"),
	argo.files[0]?.content ?? "",
);
writeFileSync(
	join(out, "hobo-set.configmap.json.golden"),
	argo.files[1]?.content ?? "",
);
writeFileSync(
	join(out, "flux.kustomization.json.golden"),
	flux.files[0]?.content ?? "",
);
