import {
  generateCodegenArtifacts,
  writeGeneratedTree,
} from "../../hobo-codegen-cli-contract/src/codegen-cli-contract.js";
import type { DevStateStore } from "./dev-state-store.js";
import { isJsonString } from "./json.js";


export interface CodegenEngine {
  generate(options: { projectRoot: string }): Promise<Array<{ path: string }>>;
  write(projectRoot: string, artifacts: Array<{ path: string }>): Promise<void>;
}

export interface WatchCodegen {
  queueSourceChange(path: string): void;
  flush(): Promise<WatchCodegenResult>;
  totalRuns(): number;
}

export interface WatchCodegenResult {
  codegenRuns: number;
  totalCodegenRuns: number;
  changedSources: string[];
  written: string[];
}

export function createWatchCodegen(
  store: DevStateStore,
  projectRoot: string,
  engine: CodegenEngine = defaultCodegenEngine(),
): WatchCodegen {
  const pending = new Set<string>();
  let totalRuns = 0;

  return {
    queueSourceChange(path: string) {
      if (!isJsonString(path) || path.length === 0) {
        throw new TypeError("path must be a non-empty string");
      }
      pending.add(path);
    },
    async flush() {
      if (pending.size === 0) {
        return { codegenRuns: 0, totalCodegenRuns: totalRuns, changedSources: [], written: [] };
      }
      const changedSources = [...pending].sort();
      pending.clear();
      const artifacts = await engine.generate({ projectRoot });
      await engine.write(projectRoot, artifacts);
      totalRuns += 1;
      const written = artifacts.map((artifact) => artifact.path);
      await store.append({
        family: "dev.CodegenRan",
        payload: { changedSources, writtenPaths: written },
      });
      return {
        codegenRuns: 1,
        totalCodegenRuns: totalRuns,
        changedSources,
        written,
      };
    },
    totalRuns() {
      return totalRuns;
    },
  };
}

function defaultCodegenEngine(): CodegenEngine {
  return {
    async generate(options) {
      return generateCodegenArtifacts({ projectRoot: options.projectRoot });
    },
    async write(projectRoot, artifacts) {
      await writeGeneratedTree(projectRoot, artifacts);
    },
  };
}
