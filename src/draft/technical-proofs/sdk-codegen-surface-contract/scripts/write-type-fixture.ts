import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fixtureSdkSources,
  generateSdkCodegenArtifacts,
  writeGeneratedTree,
} from "../src/sdk-codegen-surface.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputRoot = join(packageRoot, "tmp-generated");

await writeGeneratedTree(outputRoot, generateSdkCodegenArtifacts({ sources: fixtureSdkSources() }));
