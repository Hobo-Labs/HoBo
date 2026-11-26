package data_models

#WorkspaceEdgeRecord: {
  from_path: string & =~"^(packages|examples)/"
  to_path:   string & !=""
}

// The rules a boundary refusal is filed under: `BOUNDARY_RULES` in
// src/boundaries.ts. The last three are the engine-neutrality rules
// (ADR-0177): an orchestrator imports no data engine, and no database driver
// or engine-specific storage, at runtime; data engines do not import each
// other at runtime.
#BoundaryRule: "core-imports-hobo" | "adapter-imports-adapter" | "adapter-imports-non-core" |
  "outward-dependency" | "workspace-cycle" | "unknown-package" |
  "orchestrator-imports-engine" | "orchestrator-imports-engine-storage" | "engine-imports-engine"

#BoundaryViolationRecord: {
  rule: #BoundaryRule
  from_path: string & !=""
  to_path:   string & !=""
  effect: "deny"
}

#WorkspaceSkeletonValidatedEvent: {
  workspace_rev: string & !=""
  edges: [...#WorkspaceEdgeRecord]
  violations: [...#BoundaryViolationRecord]
}
