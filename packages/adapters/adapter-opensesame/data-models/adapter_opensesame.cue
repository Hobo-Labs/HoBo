package adapter_opensesame

// CUE constraints for the OpenSesame secrets adapter. src/binding.ts and
// src/outcome.ts parse into these shapes; test/binding.test.ts reads the
// regular expressions below out of this file and checks the parser carries
// the same ones, so there is one definition.

// A binding names a credential and bounds what a surrogate for it may do.
// An unbounded scope is unrepresentable: `paths` and `methods` are non-empty,
// which mirrors the plugin's own refusal to issue a surrogate for an entry
// with no bounded scope. Bounded is not narrow: a one-segment prefix such as
// "/v9" with all five methods is bounded by path alone, which is the operator's
// choice and which nothing here narrows.
#CredentialBinding: {
	locator:    =~"^hobo-token://[a-z0-9-]+/[a-z0-9-]+$"
	connection: =~"^conn://[a-z0-9-]+(/[a-z0-9-]+){1,2}$"
	// Only vercel is brokered. "aws" is refused with provider_not_brokered:
	// SigV4 signs in process from a live secret key, which no header
	// substitution can serve.
	provider: "vercel"
	// Not a variable the run depends on (PATH, NODE_*, OPENSESAME_*, the proxy and CA
	// variables, the loaders'): src/binding.ts builds this pattern from its two lists.
	env_name: =~"^[A-Z][A-Z0-9_]*$" & !~"^(?:HOBO_OPENSESAME_CHILD|PATH|HOME|SHELL|IFS|HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|GIT_SSL_CAINFO|(?:OPENSESAME|NODE|LD|DYLD)_[A-Z0-9_]*)$"
	// Absolute prefixes of named segments: no empty segment, no "." or ".."
	// (the rule OpenSesame's spec/conformance/surrogate-scope.json holds both
	// of its enforcers to, narrowed to characters that survive paths="a,b").
	paths: [...(=~"^/[A-Za-z0-9._~%/-]+$" & !~"//" & !~"/\\.{1,2}(/|$)")] & [_, ...]
	methods: [..."GET" | "POST" | "PUT" | "PATCH" | "DELETE"] & [_, ...]
	projection: "legacy-token"
}

// Two bindings never share a locator or a variable; that cross-record rule is
// enforced by parseCredentialBindings, which CUE cannot say over a list.
#CredentialBindings: {
	bindings: [...#CredentialBinding]
}

#ProxiedRunOutcome: {
	kind: "child_exit" | "tripwire" | "signalled" | "placeholders_only" | "scope_unbounded" | "schema_refused" | "plugin_pin_mismatch" | "store_unreadable" | "bridge_missing"
	exit_code: int & >=0 & <=255
	notice:    string & =~"^[^\n]{0,300}$"
}

#SurrogateEvidence: {
	locator:           =~"^hobo-token://[a-z0-9-]+/[a-z0-9-]+$"
	provider:          "vercel"
	connection_digest: =~"^sha256:[a-f0-9]{64}$"
	scope_digest:      =~"^sha256:[a-f0-9]{64}$"
}
