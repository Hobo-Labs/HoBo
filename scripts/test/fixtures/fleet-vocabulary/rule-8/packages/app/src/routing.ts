// @ts-nocheck -- fixture for scripts/check-fleet-vocabulary.mts: rule 8; never compiled.
import { choose } from "@hobo/backend-fleet";
import type { MeshNode } from "@hobo/ci/mesh";
import { route } from "@hobo/ci";

export const all = [choose, route] as const;
export type Node = MeshNode;
