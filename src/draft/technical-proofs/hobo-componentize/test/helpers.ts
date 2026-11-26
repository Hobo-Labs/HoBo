import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  PINNED_TOOLCHAIN,
  componentizeService,
  parseComponentizeSpec,
  type ComponentizeSpec,
} from "../src/index.js";

const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/hello-bindle", import.meta.url));

export const componentizeRealBuildSkipReason =
  process.platform === "win32" && process.arch === "arm64"
    ? "@bytecodealliance/wizer does not publish a Windows ARM64 binary"
    : undefined;

export function helloBindleSpec(overrides: Partial<ComponentizeSpec> = {}): ComponentizeSpec {
  return parseComponentizeSpec({
    name: "hello-bindle",
    sourceRoot: FIXTURE_ROOT,
    entrypoint: "src/service.ts",
    witDir: join(FIXTURE_ROOT, "wit"),
    worldName: "hello-bindle",
    sourceDateEpoch: "2026-01-01T00:00:00.000Z",
    toolchain: { ...PINNED_TOOLCHAIN },
    ...overrides,
  });
}

export async function buildHelloBindle() {
  return componentizeService(helloBindleSpec());
}
