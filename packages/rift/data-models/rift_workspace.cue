package rift

import (
	"list"
	"strings"
)

#CowTier: "reflink" | "overlayfs" | "hardlink" | "copy"

// A name proven safe to use as a single path segment. Enforced in code by
// parseWorkspaceName (src/names.ts), which returns the derived WorkspaceName
// type — the constraint below is the same rule stated declaratively.
#WorkspaceName: string & !="" & !="." & !=".." & strings.MaxRunes(64)

#Capability: {
	tier: #CowTier
	available: [...#CowTier] & list.MinItems(1)
	reason: string & !=""
	// hardlink shares inodes, so in-place writes escape to the source. The
	// constraint keeps that hazard from being reported as safe.
	isolates_in_place_writes: bool
	if tier == "hardlink" {
		isolates_in_place_writes: false
	}
}

#WorkspaceRecord: {
	name:       #WorkspaceName
	path:       string & !=""
	tier:       #CowTier
	source:     string & !=""
	created_at: string & !=""
	// Overlay layers exist for exactly one tier.
	if tier == "overlayfs" {
		upper: string & !=""
		work:  string & !=""
	}
}

#RootInitialized: {
	type: "RootInitialized"
	at:   string & !=""
	root: string & !=""
}

#WorkspaceCreated: {
	type:      "WorkspaceCreated"
	at:        string & !=""
	workspace: #WorkspaceRecord
}

#WorkspaceRemoved: {
	type: "WorkspaceRemoved"
	at:   string & !=""
	name: #WorkspaceName
}

#WorkspaceEvent: #RootInitialized | #WorkspaceCreated | #WorkspaceRemoved

#Registry: {
	root: string & !=""
	workspaces: [...#WorkspaceRecord]
}
