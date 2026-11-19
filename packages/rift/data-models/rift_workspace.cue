package rift

import (
	"list"
	"strings"
)

#CowTier: "reflink" | "overlayfs" | "hardlink" | "copy"

#WorkspaceName: string & !="" & !="." & !=".." & strings.MaxRunes(64)

#Capability: {
	tier: #CowTier
	available: [...#CowTier] & list.MinItems(1)
	reason: string & !=""
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
