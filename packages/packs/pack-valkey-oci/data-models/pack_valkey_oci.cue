// Constraints that keep a Valkey pack deployment honest.
//
// The protobuf file says which fields exist. These say which combinations are
// truthful. Most of them exist because "Redis-compatible" is read as "a
// database" far more often than it is true: the same image is a durable
// keyspace or a lossy cache depending on its durability mode and eviction
// policy, so the retention fields are constrained *against each other* rather
// than being free-form labels a receipt happens to carry.
//
// The scalars below are spelled identically to `pack_framework.cue`. They are
// restated rather than imported because each package owns its own
// `data-models/` folder, and a CUE file in another directory is a different
// package — a cross-directory reference here would resolve to nothing.

package packs

#Sha256:       =~"^sha256:[0-9a-f]{64}$"
#IsoDate:      =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
#IsoInstant:   =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$"
#AbsolutePath: =~"^/[A-Za-z0-9._/-]+$"
// The two architectures this pack publishes a pinned digest for. The index also
// lists linux/arm/v7 and linux/ppc64le; pinning a digest nobody has run would
// be a support claim without evidence.
#Architecture: "linux/amd64" | "linux/arm64"

// A locator, never material. The scheme set matches @hobo/bindings.
#SecretRef: =~"^(vault|azure-kv|aws-sm|gcp-sm|op|infisical|hobo-secret|hobo-token)://[^@?]+/[^@?]+$"

// A bare hostname. A `:` or `@` here would mean a connection string was pasted
// into an address field.
#Hostname: =~"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$"

// `host:port`, which is what a handoff endpoint is identified by.
#HostPort: =~"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?:[0-9]{1,5}$"

// Paths this pack pins. The image declares no VOLUME of its own, so the mount
// path is the pack's decision and an image bump that moves the working
// directory has to fail here rather than write into a container layer.
#DataMountPath:       "/data"
#ConfigPath:          "/etc/valkey/valkey.conf"
#RequirepassInclude:  "/run/secrets/valkey-requirepass.conf"

#DurabilityMode:  "none" | "rdb-snapshots" | "aof-everysec" | "aof-always"
#AppendFsync:     "no" | "everysec" | "always" | "not-applicable"
#EvictionPolicy:  "noeviction" | "allkeys-lru" | "allkeys-lfu" | "allkeys-random" |
	"volatile-lru" | "volatile-lfu" | "volatile-random" | "volatile-ttl"

// The default port, pinned. A cache reachable somewhere else is a cache nobody
// configured a firewall rule for.
#ContainerPort: 6379

#ValkeyImagePinRecord: {
	repository:   "docker.io/valkey/valkey"
	digest:       #Sha256
	architecture: #Architecture
	// Provenance only. Nothing resolves this tag at runtime.
	resolved_from_tag: string & !=""
	index_digest:      #Sha256
	server_version:    =~"^9\\.[0-9]+\\.[0-9]+$"
	server_major:      9
}

#ValkeyVolumeBindingRecord: {
	volume_name: "valkey-data"
	mount_path:  #DataMountPath
	// Object storage cannot back an RDB or an AOF, so there is one legal value.
	storage_kind: "local-volume"
	volume_id:    string & !=""
	// 256 MiB: enough for an AOF plus a rewrite of a modest keyspace. Larger
	// would be a guess, smaller cannot hold a rewrite.
	minimum_bytes: uint64 & >=268435456
}

#ValkeyRetentionRecord: {
	durability_mode: #DurabilityMode
	append_fsync:    #AppendFsync
	// -1 is the sentinel for "everything since the last restart". Any other
	// negative number would be a unit mistake.
	worst_case_loss_ms:          int64 & >=-1
	survives_restart:            bool
	acknowledges_before_durable: bool
	eviction_policy:             #EvictionPolicy
	evicts_keys_without_ttl:     bool
	write_behaviour_at_limit:    "error" | "evict-then-accept"
	key_loss_possible:           bool
	durable_keyspace:            bool

	// The fsync setting and the mode are one fact stated twice, so they have to
	// agree: a record claiming aof-always with everysec fsync describes a
	// server that does not exist.
	_fsyncMatchesMode: true &
		(durability_mode != "aof-always" | append_fsync == "always") &
		(durability_mode != "aof-everysec" | append_fsync == "everysec") &
		(durability_mode != "none" | append_fsync == "not-applicable") &
		(durability_mode != "rdb-snapshots" | append_fsync == "not-applicable")

	// Cache mode writes nothing to the volume: it cannot survive a restart, and
	// its loss is the whole keyspace rather than a bounded window.
	_cacheModeLosesEverything: true &
		(durability_mode != "none" | worst_case_loss_ms == -1) &
		(durability_mode != "none" | survives_restart == false)
	// Every other mode writes to the volume, so its loss is a bounded window.
	_persistentModeIsBounded: true &
		(durability_mode == "none" | worst_case_loss_ms >= 0) &
		(durability_mode == "none" | survives_restart == true)
	// An fsync per write is the only mode that does not acknowledge ahead of
	// durability. Claiming otherwise would advertise a guarantee the server is
	// not paying for.
	_ackMatchesFsync: true &
		(durability_mode != "aof-always" | acknowledges_before_durable == false) &
		(durability_mode == "aof-always" | acknowledges_before_durable == true)

	// Only the allkeys-* policies may discard a key that carries no TTL.
	_onlyAllkeysEvictsUntimedKeys: true &
		(eviction_policy == "allkeys-lru" | eviction_policy == "allkeys-lfu" |
			eviction_policy == "allkeys-random" | evicts_keys_without_ttl == false)
	// noeviction refuses the write instead of choosing a victim.
	_noevictionErrors: true &
		(eviction_policy != "noeviction" | write_behaviour_at_limit == "error") &
		(eviction_policy == "noeviction" | write_behaviour_at_limit == "evict-then-accept")

	// A key can go missing either because the server forgot it on restart or
	// because eviction chose it. Both routes have to set the flag a consumer
	// reads off the binding.
	_lossFollowsFromEitherRoute: true &
		(survives_restart == true | key_loss_possible) &
		(evicts_keys_without_ttl == false | key_loss_possible)
	// And a durable keyspace is exactly the absence of both routes.
	_durableKeyspaceNeedsBoth: true &
		(durable_keyspace == false | survives_restart) &
		(durable_keyspace == false | evicts_keys_without_ttl == false)
	_durableKeyspaceExcludesLoss: true & (durable_keyspace == false | key_loss_possible == false)
}

#ValkeyRenderedConfigRecord: {
	path:                     #ConfigPath
	directives:               [string & !="", ...string]
	digest:                   #Sha256
	requirepass_include_path: #RequirepassInclude
	// Owner-read only. A world-readable credential file is the same leak as an
	// environment variable, just slower to find.
	requirepass_include_mode: "0400"

	// The credential include is the last directive on purpose: in a Valkey
	// config the later directive wins, so an include at the end cannot be
	// overridden by anything above it.
	_includeIsLast: true &
		(directives[len(directives)-1] == "include \(requirepass_include_path)")
	// The rendered file never carries the password itself, and never the
	// locator either — the locator names the secret an executor must fetch, and
	// a config file is not where an executor looks.
	_noPlaintextRequirepass: true & (len([
		for directive in directives
		if directive =~ "(?i)^requirepass |hobo-secret://|rediss?://" {directive}
	]) == 0)
	// The data directory has to be the mounted volume, or the snapshot is
	// written into a container layer that disappears with the container.
	_dirPointsAtMount: true & (len([
		for directive in directives if directive == "dir \(#DataMountPath)" {directive}
	]) == 1)
	// Snapshots are never left to the shipped default: the stock config saves on
	// a schedule, so silence in a cache-mode deployment would mean snapshots.
	_savePolicyIsExplicit: true & (len([
		for directive in directives if directive =~ "^save " {directive}
	]) > 0)
}

#ValkeyDeploymentRecord: {
	pack_id:      "pack.valkey.oci/v1"
	pack_version: =~"^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"
	resource_ref: =~"^resource:[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$"
	image:        #ValkeyImagePinRecord
	data_volume:  #ValkeyVolumeBindingRecord
	// The image's entrypoint runs valkey-server; the config path is the single
	// positional argument it takes.
	command: ["valkey-server", #ConfigPath]
	env: [string]: string
	// Empty, and asserted so. An environment variable is visible in
	// /proc/<pid>/environ and in `docker inspect`, and nothing this pack needs
	// to say is worth putting there.
	_noEnvironment: true & (len(env) == 0)
	config:          #ValkeyRenderedConfigRecord
	auth_secret_ref: #SecretRef
	container_port:  #ContainerPort
	// 8 MiB floor: a server whose limit is smaller than its own overhead evicts
	// constantly and looks like data loss. 1 TiB ceiling: past that the number
	// is a typo rather than a plan.
	maxmemory_bytes: uint64 & >=8388608 & <=1099511627776
	databases:       uint32 & >=1 & <=256
	retention:       #ValkeyRetentionRecord

	// The config file and the retention record describe the same server, so the
	// append-only directive has to match the mode the record claims.
	_aofDirectiveMatchesMode: true &
		(retention.durability_mode == "none" | retention.durability_mode == "rdb-snapshots" |
			len([for d in config.directives if d == "appendonly yes" {d}]) == 1)
	_noAofDirectiveWithoutAofMode: true &
		(retention.durability_mode == "aof-everysec" | retention.durability_mode == "aof-always" |
			len([for d in config.directives if d == "appendonly no" {d}]) == 1)
	// And the memory limit and policy in the file are the ones recorded here,
	// not the ones the image ships with.
	_maxmemoryDirectiveMatches: true & (len([
		for d in config.directives if d == "maxmemory \(maxmemory_bytes)" {d}
	]) == 1)
	_policyDirectiveMatches: true & (len([
		for d in config.directives
		if d == "maxmemory-policy \(retention.eviction_policy)" {d}
	]) == 1)
	// A single-writer volume and the credential include both point at paths the
	// container can actually see.
	_volumeIsMounted: true & (data_volume.mount_path == #DataMountPath)
}

#ValkeyProbeResultRecord: {
	probe: "readiness" | "liveness" | "startup"
	kind:  "exec" | "tcp"
	argv?: [...string]
	port_name?:    string
	ready:         bool
	exit_code:     int32
	stdout_marker?: string
	observed_at:   #IsoInstant
	consecutive_failures: uint32

	// An exec probe carries argv; a socket probe carries a port name.
	_execHasArgv:    true & (kind != "exec" | argv != _|_)
	_socketHasPort:  true & (kind == "exec" | port_name != _|_)
	// Readiness is answered by a command, not by an open socket: during an AOF
	// or RDB load the port accepts connections and every command is refused
	// with LOADING, so a tcp readiness result would be a false positive by
	// construction.
	_readinessIsExec: true & (probe != "readiness" | kind == "exec")
	_readinessAsksPing: true &
		(probe != "readiness" | argv[0] == "valkey-cli") &
		(probe != "readiness" | argv[1] == "ping")
	// A ready verdict means the command succeeded and the server answered.
	_readyImpliesSuccess: true & (ready == false | exit_code == 0)
	_readyExecImpliesPong: true &
		(ready == false | kind != "exec" | stdout_marker == "PONG")
	_readyHasNoFailures: true & (ready == false | consecutive_failures == 0)
}

#ValkeyOperationRecord: {
	operation_id: "valkey.backup.rdb-dump" | "valkey.migration.replica-handoff" |
		"valkey.maintenance.rewrite-aof"
	kind:         "backup" | "restore" | "migration" | "maintenance"
	profile_ref?: string
	// Every operation this pack builds speaks the protocol through the CLI.
	argv: ["valkey-cli", ...string]
	env: [string]: string
	// Locators only, under the one variable the CLI reads a password from. The
	// struct is closed, so no second variable can smuggle a resolved value in
	// beside the locator.
	secret_env: {
		REDISCLI_AUTH: #SecretRef
	}
	timeout_ms:     uint32 & >0
	exit_code?:     int32
	artifact_path?: #AbsolutePath

	// No shell means no metacharacters need escaping — but a credential in argv
	// is visible through `ps` to every process on the host, so it is rejected
	// outright.
	_noCredentialInArgv: true & (len([
		for element in argv
		if element =~ "(?i)(rediss?://|requirepass|--pass|//[^/:@]+:[^/:@]+@)" {element}
	]) == 0)
	// The operation id and the kind are one fact stated twice.
	_idMatchesKind: true &
		(operation_id != "valkey.backup.rdb-dump" | kind == "backup") &
		(operation_id != "valkey.migration.replica-handoff" | kind == "migration") &
		(operation_id != "valkey.maintenance.rewrite-aof" | kind == "maintenance")
	// A backup that names no artifact produced nothing a restore can read.
	_backupNamesArtifact: true & (kind != "backup" | artifact_path != _|_)
	// The RDB is produced by the server over the protocol rather than copied
	// off the volume, so the backup means the same thing in cache mode as in
	// aof-always.
	_backupAsksTheServer: true & (operation_id != "valkey.backup.rdb-dump" | len([
		for element in argv if element == "--rdb" {element}
	]) == 1)
}

#ValkeyHandoffRecord: {
	profile_ref: "migration.valkey.replica-handoff/v1"
	replicate:   #ValkeyOperationRecord & {operation_id: "valkey.migration.replica-handoff"}
	await_sync:  #ValkeyOperationRecord & {operation_id: "valkey.migration.replica-handoff"}
	promote:     #ValkeyOperationRecord & {operation_id: "valkey.migration.replica-handoff"}
	source_endpoint: #HostPort
	target_endpoint: #HostPort

	// A server cannot replicate from itself, so a handoff whose endpoints match
	// moves nothing and would leave the target pointing at its own address.
	_distinctEndpoints: true & (source_endpoint != target_endpoint)
	// Every step is issued to the target: it is the server whose role changes.
	_replicateAttaches: true & (len([
		for element in replicate.argv if element == "REPLICAOF" {element}
	]) == 1)
	// The wait is a real question with an answer, not a sleep.
	_awaitAsksReplicationState: true & (len([
		for element in await_sync.argv if element == "replication" {element}
	]) == 1)
	_promoteDetaches: true &
		(promote.argv[len(promote.argv)-3] == "REPLICAOF") &
		(promote.argv[len(promote.argv)-2] == "NO") &
		(promote.argv[len(promote.argv)-1] == "ONE")
}

#ValkeyBindingRecord: {
	binding_id:             string & !=""
	resource_ref:           =~"^resource:[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$"
	capability_profile_ref: "kv.redis-compatible/v1"
	binding_profile_ref:    "binding.redis-protocol/v1"
	host:                   #Hostname
	port:                   uint32 & >=1 & <=65535
	tls:                    bool
	database:               uint32 & >=0 & <=255
	credential_secret_ref:  #SecretRef
	certificate_secret_ref?: #SecretRef
	image_digest:            #Sha256
	retention:               #ValkeyRetentionRecord
	// Literal, not a field an author fills in. Lists look like a queue and
	// streams look like a log, and neither carries redelivery, a visibility
	// timeout, or consumer-group guarantees.
	delivery_guarantees:   "none"
	producer_evidence_ref: string & !=""

	// Requiring TLS without naming the certificate to verify against is how a
	// client ends up trusting anything that answers on the port.
	if tls {
		certificate_secret_ref!: #SecretRef
	}
}

#ValkeyConformanceRecord: {
	suite_ref: "hobo.conformance/pack.valkey.oci/v1"
	profile_ref: "kv.redis-compatible/v1" | "kv.valkey/v1" | "kv.key-value/v1" |
		"migration.valkey.replica-handoff/v1"
	outcome:             "pass" | "fail" | "unknown"
	evidence_checked_at: #IsoDate
	// Required, not defaulted: replayed-fixture evidence and a real container
	// run are different claims, and the distinction has to survive into the
	// read store rather than being inferred later.
	executed_against_container: bool
	image_digest:               #Sha256
	architecture:               #Architecture
	durability_mode:            #DurabilityMode

	// A pass is only meaningful against a specific image, so evidence recorded
	// for one digest never transfers to another.
	_evidenceIsDigestScoped: true & (image_digest != "")
	// There is no queue or topic profile in the enum above, and that omission
	// is the point: this suite has no evidence for delivery semantics.
}
