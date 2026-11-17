# `@hobo/rift` architecture

A sidecar that gives every agent its own copy-on-write checkout. It exists
because upstream [rift](https://github.com/anomalyco/rift) cannot run on the
machines we actually develop on: it requires btrfs, XFS-with-reflinks, or APFS,
and ships per-platform binaries. On ext4/linux-arm64 both conditions fail, and an
agent multiplexer relying on it quietly degrades every agent to one shared
checkout — which is precisely the collision the feature exists to prevent.

## Capability ladder (the core decision)

The host is probed, never assumed. Tiers, best first:

| Tier | Mechanism | Isolates in-place writes |
|---|---|---|
| `reflink` | `cp --reflink=always` (FICLONE) | yes |
| `overlayfs` | `unshare -Urm` + unprivileged overlay mount | yes |
| `hardlink` | `cp -al` | **no** |
| `copy` | `cp -a` | yes |

`hardlink` is ranked **below** `overlayfs` on purpose. Hardlinked files share an
inode, so `>>` or `sed -i` inside a workspace modifies the source. It stays in
the ladder only as a cheaper last resort than a full copy, and `capability`
reports `isolatesInPlaceWrites: false` so the hazard is never presented as
equivalent isolation.

The overlay tier's merged path exists **only inside a mount namespace**. `cd`
from outside finds an empty directory, so commands must go through
`hobo-rift exec`, which re-establishes the mount around them. A multiplexer
should wrap every tmux pane command in `hobo-rift exec` for exactly this reason,
and depend on `@hobo/rift` as a package so the binary is always present —
resolving through `PATH` alone leaves the feature inert, with every agent
falling back to a git worktree.

Inside the namespace, `.hobo-rift` is masked with an empty tmpfs. The lower
layer is the whole source, which contains every other agent's upper layer.

**This is containment, not a sandbox.** The mask hides the workspaces
directory *at its path inside the merged view*; it does not remove the process's
ability to reach the source tree by its real absolute path. An agent that walks
out to `/path/to/source/.hobo-rift/workspaces/other/upper` still reads it, and a
write to an absolute path in the source still lands in the source. What the
isolation buys is that ordinary relative-path work — which is what agents
actually do — cannot collide. Treat it as protection against accident, not
against a hostile process.

## Schema and constraints

Records, messages, and events are defined in
[`data-models/rift_workspace.proto`](data-models/rift_workspace.proto) and
constrained in [`data-models/rift_workspace.cue`](data-models/rift_workspace.cue):
`Capability`, `WorkspaceRecord`, the `WorkspaceEvent` union, and the `Registry`
projection. The CUE encodes the invariants the prose states — notably that a
`hardlink` capability may not claim `isolates_in_place_writes: true`, and that
overlay layer paths exist for exactly the overlay tier.

## Parse, don't validate

Workspace names are **parsed derived types**, not checked strings.
`parseWorkspaceName` ([`src/names.ts`](src/names.ts)) returns a branded
`WorkspaceName`, and only a `WorkspaceName` reaches a path join. This is a
security boundary, not tidiness: the name is a path segment, so an unparsed
string is a traversal primitive — `--name ../../etc` would have created a
workspace outside the root and `--name ..` would have made `remove` delete the
root's own bookkeeping. Making the unsafe path a *type error* is what keeps a
future caller from reintroducing it.

## Event architecture

Workspace lifecycle is event-sourced, because creation touches the filesystem
before it touches bookkeeping and a crash between the two used to leave an
orphan directory nothing knew about.

- **Commands** — `init`, `create`, `remove`, issued through the CLI.
- **Events** — `RootInitialized`, `WorkspaceCreated`, `WorkspaceRemoved`.
- **Event store** — `.hobo-rift/events.jsonl`, append-only, one JSON object per
  line written with a single `appendFileSync` so a concurrent reader never sees
  half a record. A truncated tail line — the expected crash shape — is skipped
  rather than treated as fatal.
- **Actor** — the CLI process, serialized per root: one command appends one
  event and then refreshes the view.
- **Materialized view / projection** — `projectWorkspaces` folds the journal
  into the current workspace set. It is pure, so it is tested without a
  filesystem and can be replayed at any time.
- **Snapshot** — `.hobo-rift/registry.json`, the persisted projection, for other
  readers. It is never authoritative: `record()` appends the event and rewrites
  the snapshot as two steps, so a crash between them leaves a snapshot that
  parses perfectly and is stale. `hobo-rift repair` rewrites it explicitly.
- **Read store** — `list` and `readRegistry` project from the journal whenever
  one exists, and consult the snapshot only for a root that predates
  journalling. Preferring the snapshot made a real workspace invisible to
  `list`, `exec` and `remove` until someone thought to run `repair`.

`create` never deletes a directory it cannot prove is dead. A name the registry
does not list is *probably* debris, but the same state arises from a lost
journal — where the directory holds an agent's uncommitted work — and from a
clone another process is still running. Since a multiplexer may call create on
every run, deleting would turn one lost journal into silent, irreversible loss
of every agent's tree. The directory is renamed to `<name>.debris` instead, and
the new location is reported.

`repair` restores from the snapshot only when the snapshot records a **larger**
`eventCount` than the journal now holds, which is what truncation looks like. A
snapshot that merely predates the last event is stale, and restoring from it
would resurrect a workspace someone removed on purpose — written into the
append-only journal, where it could never again be told from a real creation.
`existsSync` on the workspace path cannot make this distinction: a surviving
directory is the *signature* of a crash between recording a removal and
performing it.

Creation writes a `WorkspaceCreating` intent **before** touching the
filesystem, because the clone is the long part and a crash inside it used to
leave a directory nothing knew about — invisible to `list`, yet enough to make
every later `create --name same` fail with "already exists" forever. Such
debris is now cleared on the next create. `remove` likewise records before it
deletes.

## Boundaries

The only interface a caller depends on is the CLI: argv in, exit code plus
stdout out. That boundary is pinned by
[`contracts/pacts/rift-workspace-boundary.pact.json`](contracts/pacts/rift-workspace-boundary.pact.json)
and **executed** by `test/pact.test.ts`, which runs the built binary once per
interaction. Writing that contract is what surfaced two real defects: flags
placed before the verb were parsed as the verb (turning `create` into a help
screen with exit 0), and failures such as a duplicate name or an unknown
workspace exited 0.

`exec` against an unknown workspace fails rather than falling back to the source
tree — running an agent's command against the tree the workspace exists to
protect is the worst available outcome.

## Non-negotiables

- Never report a tier as isolating when it does not.
- Never join an unparsed name onto a path.
- Never let a torn snapshot lose workspaces that the journal still records.
- Never silently fall back to the source tree.
