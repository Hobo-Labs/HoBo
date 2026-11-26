// Invariants for Convex app discovery.
//
// The protobuf shapes say which fields exist. These say which combinations are
// truthful: a root stays inside the repo, an auth config cannot exist without
// the directory that holds it, a discovered WorkOS key is supplied by an
// external resource rather than by app config, and no field ever holds the
// value of a credential.

package convex

import "strings"

// Repo-relative and forward-slashed. A leading "/" or any ".." segment is
// rejected at the parse boundary, so neither is representable here.
#RepoRelativePath: string & !="" & =~"^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$" &
	!~"(^|/)\\.\\.(/|$)"

#AbsolutePath: =~"^/[A-Za-z0-9._/-]+$"

// POSIX environment variable name. Lowercase is excluded on purpose: a
// lowercased key is a typo that would silently never be supplied.
#EnvVarName: =~"^[A-Z][A-Z0-9_]*$"

#ConvexBindleKind: "env" | "external" | "data"

#ConvexWebAppMetaRecord: {
	// There is one framework this package speaks for. A second value here would
	// mean the marker had stopped being a Convex marker.
	framework: "convex"
	root:      #RepoRelativePath
}

#ConvexEnvDependencyRecord: {
	kind: #ConvexBindleKind
	// A bucket has to say how it is supplied, or a reviewer cannot tell a
	// broker-minted key from a pasted one.
	via: string & !=""
	keys: [#EnvVarName, ...#EnvVarName]
	// `via` describes a mechanism. Anything long and opaque enough to be a
	// token is not a description of one.
	_viaIsNotMaterial: true & (via !~ "[A-Za-z0-9+/_-]{32,}")
	// WorkOS keys are AuthKit's, not the app's: they come from b.external() or a
	// Camp secretRef, never from `env`.
	_workosIsExternal: true &
		(len([for k in keys if strings.HasPrefix(k, "WORKOS_") ||
			strings.HasPrefix(k, "VITE_WORKOS_") {k}]) == 0 | kind == "external")
	// The Convex URL is whatever Matching realized, so it rides the data
	// binding rather than being configured.
	_convexUrlIsData: true &
		(len([for k in keys if k == "VITE_CONVEX_URL" {k}]) == 0 | kind == "data")
}

#ConvexAppDiscoveryRecord: {
	root:    #RepoRelativePath
	absRoot: #AbsolutePath
	// Observations, never assumptions.
	hasConvexDir:  bool
	hasAuthConfig: bool
	generalEnv: [...#EnvVarName]
	suggestedDeps: [...#ConvexEnvDependencyRecord]

	// The resolved path is the repo root joined with the relative one. A record
	// whose absolute path does not end in its own root came from a resolution
	// that escaped, which is the case `resolveConvexRoot` throws on.
	_absRootEndsWithRoot: true & strings.HasSuffix(absRoot, root)
	// convex/auth.config.ts lives inside convex/, so an auth config without the
	// directory is an impossible observation rather than an unusual one.
	_authConfigImpliesDir: true & (hasAuthConfig == false | hasConvexDir)
	// Every discovered key is bucketed exactly once: a key in no bucket is a
	// dependency nobody supplies, and a key in two is an ambiguous one.
	_everyKeyBucketedOnce: true & ([for k in generalEnv if len([
		for d in suggestedDeps for dk in d.keys if dk == k {dk},
	]) != 1 {k}] == [])
	// A shippable Convex app needs its deploy key, and the deploy key is
	// broker-minted rather than authored.
	if hasConvexDir {
		generalEnv: [...#EnvVarName] & [_, ...]
		_hasDeployKey: true &
			(len([for k in generalEnv if k == "CONVEX_DEPLOY_KEY" {k}]) == 1)
	}
}
