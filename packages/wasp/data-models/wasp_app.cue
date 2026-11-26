// CUE constraints for every protobuf type in wasp_app.proto.
//
// The invariants here are the ones that keep an ingested app tree from
// smuggling something into a Bindle manifest: a root that escapes the repo, a
// value that came out of a `.env` file, a client-scope key that is not
// `REACT_APP_*` (and therefore is not actually public), or a `container`
// suggestion for a key that is plainly a third-party API credential.

package wasp_app

import "list"

#WaspEnvScope: "server" | "client" | "general"

#WaspBindleKind: "container" | "bucket" | "external" | "env"

// Env keys are shouty snake case, as both Wasp and dotenv require.
#WaspEnvKey: =~"^[A-Z][A-Z0-9_]{0,127}$"

// Wasp compiles client env vars into the browser bundle, so the prefix is not
// a convention — it is the reason the value is allowed to be public.
#WaspClientEnvKey: #WaspEnvKey & =~"^REACT_APP_"

// Repo-relative, forward-slashed, no `..` segment, no leading slash. The
// escape check lives in the parser too; this is the shape that makes the
// escape expressible in the first place.
#WaspRelativePath: =~"^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$" & !~"(^|/)\\.\\.(/|$)"

#WaspAppRoot: {
	relative: #WaspRelativePath

	// Absolute, POSIX or Windows-drive rooted. That the absolute form is the
	// repo root joined with `relative` — and stays inside it — is the parser's
	// job (`parseWaspAppRoot`), because CUE cannot see the repo root here.
	absolute: =~"^(/|[A-Za-z]:[\\\\/])"
}

#WaspWebAppAnnotation: {
	// Pinned, not merely typed: Bindle detects the webapp annotation
	// structurally, so a drifted provider or option string would silently stop
	// being detected rather than fail.
	provider:  "hobo"
	option:    "webapp"
	framework: "wasp"
	root:      #WaspRelativePath
}

#WaspEnvExampleFile: {
	relative_path: ".env.server.example" | ".env.client.example"
	scope:         "server" | "client"
	keys: [...#WaspEnvKey] & list.UniqueItems()

	if relative_path == ".env.server.example" {
		scope: "server"
	}
	if relative_path == ".env.client.example" {
		scope: "client"

		// A client key without the prefix would never reach the browser, so a
		// parsed one means the file (or the parser) is wrong.
		keys: [...#WaspClientEnvKey]
	}
}

#WaspBindleDependencySuggestion: {
	kind: #WaspBindleKind
	via:  string & !=""
	keys: [...#WaspEnvKey] & list.MinItems(1)

	// The three suggestions this package will actually make about a specific
	// key, pinned so a future edit cannot turn a third-party credential into
	// something HoBo claims to provision.
	if kind == "container" {
		keys: ["DATABASE_URL"]
	}
	if kind == "bucket" {
		keys: [...(#WaspEnvKey & =~"^AWS_S3_")]
	}
	if kind == "env" {
		keys: [...#WaspClientEnvKey]
	}
}

#WaspAppDiscovery: {
	root: #WaspAppRoot

	// The four vars the Open SaaS deploy guide requires of any deployment,
	// independent of what the app's own example files happen to list.
	general_env: [
		"DATABASE_URL",
		"JWT_SECRET",
		"WASP_WEB_CLIENT_URL",
		"WASP_SERVER_URL",
	]
	server: #WaspEnvExampleFile & {relative_path: ".env.server.example"}
	client: #WaspEnvExampleFile & {relative_path: ".env.client.example"}
	suggested_deps: [...#WaspBindleDependencySuggestion]
}
