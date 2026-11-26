// CUE constraints for every protobuf type in resource_resolver.proto. These
// are load-bearing for the direct-provider-API deployment path: the transport
// URL must be https with no userinfo, no explicit port, and no percent-encoded
// dot segment (each is a way to point a credentialed call at an origin nobody
// allowlisted); every bound is a positive number, since an unbounded call on a
// credentialed connection is an outage waiting for a slow origin; the resolver
// action vocabulary is closed so a caller can tell a create from a duplicate;
// every outcome names a physical id; and credential_ref must match the
// scheme://... locator grammar, so a connection string, bearer token, PEM
// block, or anything with embedded userinfo is refused before it can reach the
// event log, the plan digest, or a diagnostic printed from them.

package core

#TransportMethod: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

// https, a bare lowercase host (no userinfo, no port), and a path/query that
// cannot smuggle an authority separator or a percent-encoded dot segment. The
// "%2e"/"%2f" screen is a negative match, which RE2 — and therefore CUE —
// cannot express; `guardTransport` refuses those with
// TRANSPORT_PATH_FORBIDDEN before a record ever reaches this shape.
#TransportUrl: =~"^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(/[^\\s?#@]*)?(\\?[^\\s#@]*)?$"

// An exact host: no wildcard, no leading dot, no port.
#TransportHost: =~"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$"

// A prefix is anchored at the root and never contains a dot segment.
#TransportPathPrefix: =~"^(/[A-Za-z0-9._~-]+)+/?$"

#TransportGuardErrorCode: "TRANSPORT_SCHEME_FORBIDDEN" | "TRANSPORT_HOST_FORBIDDEN" | "TRANSPORT_PATH_FORBIDDEN" | "TRANSPORT_TIMEOUT_EXCEEDED" | "TRANSPORT_BODY_TOO_LARGE" | "TRANSPORT_REDIRECT_REFUSED"

#ResolverAction: "create" | "update" | "replace" | "delete" | "adopt" | "noop"

#ResolverErrorCode: "RESOLVER_CREDENTIAL_MISSING" | "RESOLVER_CREDENTIAL_NOT_A_REF" | "RESOLVER_PRODUCT_UNSUPPORTED" | "RESOLVER_PROVIDER_REJECTED" | "RESOLVER_OUTPUT_UNPARSEABLE"

// A locator names where material lives. The host segment forbids "@", which
// is how a connection string carries a password, and the whole value forbids
// whitespace, which is how an Authorization header value or a PEM block would
// arrive.
#CredentialLocator: =~"^[a-z][a-z0-9+.-]*://[^\\s@]+$"

// Lowercase provider/product id.
#ResolverId: =~"^[a-z0-9][a-z0-9._/-]{0,127}$"

// One name in a resolver's `directives` list: the realization parameter key
// of a directive (how reconcile or delete acts, never what the resource is),
// bounded, with no separators (ADR-0175). The list is distinct names; the
// TypeScript parser `parseResolverDirectives` holds the same pattern.
#Directive: =~"^[A-Za-z][A-Za-z0-9_]{0,63}$"

// Author-facing id: stable across redeploys, safe in a path segment.
#LogicalId: =~"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"

// Provider-assigned id: opaque, single non-blank token, bounded.
#PhysicalId: =~"^\\S{1,256}$"

#TransportGuardPolicyRecord: {
	// An empty allowlist is a valid policy that reaches nothing; it is never
	// read as "allow everything".
	allowed_hosts: [...#TransportHost]
	allowed_path_prefixes: [...#TransportPathPrefix]
	max_timeout_ms:     int & >0 & <=300000
	max_response_bytes: int & >0 & <=67108864
}

#TransportRequestRecord: {
	method: #TransportMethod
	url:    #TransportUrl
	// JSON-encoded body; empty for the methods that carry none.
	body_json: string
	timeout_ms:         int & >0 & <=300000
	max_response_bytes: int & >0 & <=67108864
}

#TransportGuardRefusalRecord: {
	code:    #TransportGuardErrorCode
	message: string & !=""
}

#ResolvedResourceRefRecord: {
	slot:       #CapabilitySlot
	product_id: #ResolverId
	logical_id: #LogicalId
	// Empty until the provider has assigned one. Provider ids are opaque —
	// ARNs carry colons, Vercel ids carry underscores — so the only invariant
	// is that it is a single non-blank token.
	physical_id: #PhysicalId | ""
}

#ResolveRequestRecord: {
	ref:            #ResolvedResourceRefRecord
	credential_ref: #CredentialLocator
	// JSON-encoded non-sensitive values under code-unit-sorted keys. The
	// credential-key screen
	// (secret|password|token|credential|private[_-]?key|api[_-]?key) is a
	// negative match, which RE2 — and therefore CUE — cannot express; it is
	// enforced at the `parseResolveRequest` boundary, which refuses with
	// RESOLVER_CREDENTIAL_NOT_A_REF before a record ever reaches this shape.
	desired: [=~"^\\S+$"]:  string
	observed: [=~"^\\S+$"]: string
}

#ResolveOutcomeRecord: {
	contract: "hobo.resource-resolver/v1"
	action:   #ResolverAction
	// Always present, including on a delete: the outcome names the resource it
	// acted on, or a caller cannot tell a working deploy from a duplicate.
	physical_id: #PhysicalId
	outputs: [=~"^\\S+$"]: string
	diagnostics: [...string & !=""]
}

#ResolverRefusalRecord: {
	code: #ResolverErrorCode
	// Set once the product was recognized; empty when the refusal came first.
	product_id: #ResolverId | ""
	// The credential screen only runs once the ref has parsed, so a missing
	// credential always knows which product asked for it.
	if code == "RESOLVER_CREDENTIAL_MISSING" {
		product_id: #ResolverId
	}
	message: string & !=""
}
