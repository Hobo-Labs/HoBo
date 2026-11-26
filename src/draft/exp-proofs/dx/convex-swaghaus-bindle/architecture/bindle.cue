// CUE constraints for every protobuf type in bindle.proto: formats, the
// required resource topology, and the env-routing rules an author may not
// bypass. src/parse.ts is the executable mirror of these constraints.

package convex_swaghaus_bindle

import "list"

// ---- formats ----------------------------------------------------------

// Bindle resource names are DNS-safe labels (they reach named endpoints).
#ResourceName: string & =~"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"

// Env var names only — an authored Bindle never carries values (ADR-0027).
#EnvName: string & =~"^[A-Z][A-Z0-9_]*$"

// Repo-relative Convex app directory: no absolute path, no `..` escape
// (mirrors resolveConvexRoot in @hobo/convex).
#RepoRelativePath: string & =~"^[A-Za-z0-9._][A-Za-z0-9._/-]*$" & !~"(^|/)\\.\\.(/|$)"

// ---- enums ------------------------------------------------------------

#BindleResourceKind: "data" | "external" | "web"

#EnvRouting: "env" | "external" | "data"

// ---- messages ---------------------------------------------------------

#BindleResourceRef: {
	name: #ResourceName
	kind: #BindleResourceKind
	depends_on: [...#ResourceName]

	// A resource never depends on itself.
	_no_self_edge: true & !list.Contains(depends_on, name)
}

#EnvDependency: {
	name:    #EnvName
	routing: #EnvRouting
	via:     string & !=""

	// The routing rules in @hobo/convex `ENV_TO_BINDLE_KIND`: WorkOS AuthKit
	// names ride a `b.external()` connector, the Convex URL is an output of the
	// realized `b.data()` resource, and the deploy key is a broker/Camp value.
	if name =~ "^(VITE_)?WORKOS_" {
		routing: "external"
	}
	if name == "VITE_CONVEX_URL" {
		routing: "data"
	}
	if name == "CONVEX_DEPLOY_KEY" {
		routing: "env"
	}
}

#SwaghausBindleShape: {
	web_root: #RepoRelativePath
	// The only framework this experience packages; the marker comes from
	// `convexApp(root)`, not from a provider pin.
	framework: "convex"
	app_name:  #ResourceName
	resources: [...#BindleResourceRef]
	env_deps: [...#EnvDependency]

	// swaghaus is one web Kit over a data backend plus the WorkOS external.
	_one_web: true & (len([for r in resources if r.kind == "web" {r}]) == 1)
	_has_data: true & (len([for r in resources if r.kind == "data" {r}]) >= 1)
	_has_external: true & (len([for r in resources if r.kind == "external" {r}]) >= 1)

	// Every ship-required env name is routed exactly once.
	_env_names: [for dep in env_deps {dep.name}]
	_unique_env: true & (len(_env_names) == len({for n in _env_names {(n): true}}))
}

// ---- allowed state transitions ---------------------------------------

// The authoring lifecycle: a manifest is drafted, parsed, then either matched
// by the control plane or refused (provider pin, missing topology, plaintext
// secret). `refused` and `matched` are terminal for one authoring pass.
#AuthoringPhase: "drafted" | "parsed" | "matched" | "refused"

#AuthoringTransitions: {
	[#AuthoringPhase]: [...#AuthoringPhase]

	drafted: ["parsed", "refused"]
	parsed: ["matched", "refused"]
	matched: []
	refused: []
}
