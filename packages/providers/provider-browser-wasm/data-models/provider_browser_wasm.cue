// CUE constraints for every protobuf type in provider_browser_wasm.proto.
//
// A browser is not a cluster: there is no scheduler to reject a bad placement,
// no OOM killer that leaves the rest of the machine alone, and no supervisor to
// restart a guest that wedged. Almost everything here is therefore a bound that
// has to hold *before* instantiation, because after it the failure mode is a
// frozen tab.

package provider_browser_wasm

import (
	"list"
	"math"
)

// The guest id becomes a DNS label in the station URL, so it is bounded by DNS
// rules and not by what a filesystem would tolerate.
#Dns1123Label: =~"^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$"

// Content addressing, lowercase hex, one algorithm. A digest field that
// accepted several algorithms would need agility logic nobody has written.
#ContentDigest: =~"^sha256-[0-9a-f]{64}$"

// WIT interface / world ids: `namespace:package/interface@x.y.z`.
#WitId: =~"^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*(/[a-z][a-z0-9-]*)?(@[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?)?$"

// Same-origin absolute path. A bundle URL with a scheme is a cross-origin
// fetch, which this provider does not do: the component is served by the page
// that is going to run it.
#SameOriginPath: =~"^/[A-Za-z0-9._~/-]{1,512}$"

#HttpsOrigin: =~"^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$"

#BrowserWasmPersistenceMode: "opfs-sahpool" | "transient-memory" | "unavailable"

#BrowserWasmGuestPhase: "fetched" | "running" | "terminated" | "failed"

#BrowserWasmCleanupState: "released" | "retained" | "orphaned"

#BrowserWasmPort: "compute" | "kv" | "queue"

#BrowserWasmResourceClass: "browser-wasm:guest" | "browser-wasm:kv" | "browser-wasm:queue"

// 16 MiB .. 1 GiB, and a whole number of 64 KiB WebAssembly pages. A limit that
// is not page-aligned is rounded up by the engine, so storing the unrounded
// number means the receipt disagrees with the memory the guest actually got.
#WasmMemoryLimit: uint64 & >=16777216 & <=1073741824 & math.MultipleOf(65536)

#BrowserWasmHostCapabilities: {
	schema_version:        "hobo.browser-wasm.host-capabilities/v1"
	origin:                #HttpsOrigin
	cross_origin_isolated: bool
	dedicated_workers:     bool
	persistence:           #BrowserWasmPersistenceMode
	max_memory_bytes:      #WasmMemoryLimit

	// OPFS sync access handles exist only in a worker. A host that reports
	// durable persistence without workers is describing something it cannot do.
	if persistence == "opfs-sahpool" {
		dedicated_workers: true
	}
}

#BrowserWasmPlacementRequest: {
	guest_id:           #Dns1123Label
	port:               #BrowserWasmPort
	resource_class:     #BrowserWasmResourceClass
	world:              #WitId
	persistence:        "opfs-sahpool" | "transient-memory"
	memory_limit_bytes: #WasmMemoryLimit
	shared_memory:      bool
	// 1 ms .. 5 min. There is no OS to kill a guest that never yields, so the
	// epoch deadline is the only thing standing between a runaway loop and a
	// frozen tab — an unbounded one is the same as no deadline at all.
	epoch_deadline_ms: uint32 & >=1 & <=300000
	required_imports: [...#WitId]

	// A placement cannot ask for `unavailable`; that is an outcome, not a
	// request. The pairing below is the one that matters:
	_class_matches_port: true & (
		(port == "compute" && resource_class == "browser-wasm:guest") ||
		(port == "kv" && resource_class == "browser-wasm:kv") ||
		(port == "queue" && resource_class == "browser-wasm:queue"))
}

#BrowserWasmGuestManifest: {
	schema_version:     "hobo.browser-wasm.guest-manifest/v1"
	guest_id:           #Dns1123Label
	port:               #BrowserWasmPort
	resource_class:     #BrowserWasmResourceClass
	world:              #WitId
	component_path:     #SameOriginPath & =~"\\.wasm$"
	content_digest:     #ContentDigest
	// 8 bytes is the component-model preamble; 64 MiB is more than a browser
	// should be asked to compile on a page load.
	byte_length:        uint64 & >=8 & <=67108864
	imports: [...#WitId]
	exports: [...#WitId] & list.MinItems(1)
	persistence:        #BrowserWasmPersistenceMode
	memory_limit_bytes: #WasmMemoryLimit
	shared_memory:      bool

	// A component that exports nothing cannot be a placement target, and one
	// whose path does not sit under its own guest id is describing someone
	// else's bundle.
	_path_scoped: true & (component_path =~ "^/_hobo/guests/[a-z0-9-]+/")
}

#BrowserWasmComponentArtifact: {
	content_digest: #ContentDigest
	byte_length:    uint64 & >=8 & <=67108864
	// `WebAssembly.compileStreaming` rejects anything else, so accepting a
	// different type here would only move the failure later.
	media_type: "application/wasm"
	// A core module has the same magic and a different layer. Instantiating one
	// against a component world fails in a way that reads as a host bug.
	component_model: true
}

#BrowserWasmGuestHandle: {
	guest_id:           #Dns1123Label
	origin:             #HttpsOrigin
	partition_id:       string
	worker_name:        string
	phase:              #BrowserWasmGuestPhase
	instantiated_at_ms: int & >=0
	failure_reason:     string

	// A running guest has a start instant; a fetched-but-not-instantiated one
	// cannot have acquired one.
	if phase == "running" {
		_started:       true & (instantiated_at_ms > 0)
		failure_reason: ""
	}
	if phase == "fetched" {
		instantiated_at_ms: 0
		failure_reason:     ""
	}
	if phase == "failed" {
		failure_reason: =~"^[A-Z][A-Z0-9_]{2,63}$"
	}
}

#BrowserWasmProvisionReceipt: {
	schema_version: "hobo.provider-browser-wasm.receipt/v1"
	provider_id:    "browser-wasm"
	placement:      #BrowserWasmPlacementRequest
	host:           #BrowserWasmHostCapabilities
	manifest:       #BrowserWasmGuestManifest
	artifact:       #BrowserWasmComponentArtifact
	handle:         #BrowserWasmGuestHandle
	effective_persistence: #BrowserWasmPersistenceMode
	guest_url:      #HttpsOrigin

	// The bundle that was fetched has to be the guest that was asked for, and
	// the bytes have to be the bundle the manifest described.
	_manifest_is_placement: true & (manifest.guest_id == placement.guest_id)
	_world_agrees:          true & (manifest.world == placement.world)
	_digest_verified:       true & (artifact.content_digest == manifest.content_digest)
	_length_verified:       true & (artifact.byte_length == manifest.byte_length)
	_handle_is_guest:       true & (handle.guest_id == placement.guest_id)
	_handle_origin:         true & (handle.origin == host.origin)

	// Shared linear memory needs SharedArrayBuffer, which needs cross-origin
	// isolation. A receipt claiming both shared memory and a non-isolated host
	// describes an instantiation that cannot have happened.
	if placement.shared_memory {
		host: cross_origin_isolated: true
	}

	// Durability is only claimable when the host reported it AND the guest got
	// a worker AND a partition. Downgrade is allowed; silently claiming the
	// upgrade is not.
	if effective_persistence == "opfs-sahpool" {
		host: persistence: "opfs-sahpool"
		handle: worker_name: =~"^[a-z0-9][a-z0-9-]{2,63}$"
		handle: partition_id: =~"^[a-z0-9][a-z0-9-]{2,63}$"
	}
	if effective_persistence != "opfs-sahpool" {
		handle: partition_id: ""
	}
}

#BrowserWasmCleanupOutcome: {
	guest_id:          #Dns1123Label
	state:             #BrowserWasmCleanupState
	worker_terminated: bool
	partition_dropped: bool
	released_at_ms:    int & >0
	retained_reason:   string

	// "Released" is the only state that claims nothing is left behind, so it is
	// the only one that has to prove both halves.
	if state == "released" {
		worker_terminated: true
		partition_dropped: true
		retained_reason:   ""
	}
	if state == "retained" {
		worker_terminated: true
		partition_dropped: false
		retained_reason:   =~"^[a-z][a-z0-9-]{2,63}$"
	}
	// An orphan is what a closed tab leaves; by definition nobody ran cleanup.
	if state == "orphaned" {
		worker_terminated: false
		partition_dropped: false
		retained_reason:   "tab-closed"
	}
}

#BrowserWasmHostFault: {
	schema_version: "hobo.browser-wasm.host-fault/v1"
	code:           "GUEST_NOT_FOUND" | "BUNDLE_UNAVAILABLE" | "HOST_UNSUPPORTED"
	message:        string & !="" & =~"^[^\\x00-\\x1f]{1,512}$"
	guest_id:       #Dns1123Label
}
