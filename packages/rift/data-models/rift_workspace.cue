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
	reason:                string & !=""
	isolatesInPlaceWrites: bool
	if tier == "hardlink" {
		isolatesInPlaceWrites: false
	}
}

#WorkspaceRecord: {
	name:      #WorkspaceName
	path:      string & !=""
	tier:      #CowTier
	source:    string & !=""
	createdAt: string & !=""
	upper?:    string
	work?:     string
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

#WorkspaceCreating: {
	type: "WorkspaceCreating"
	at:   string & !=""
	name: #WorkspaceName
	path: string & !=""
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

#WorkspaceEvent: #RootInitialized | #WorkspaceCreating | #WorkspaceCreated | #WorkspaceRemoved

#Registry: {
	root: string & !=""
	workspaces: [...#WorkspaceRecord]
	eventCount: uint & <=4294967295
}

#RepairResult: {
	root: string & !=""
	workspaces: [...#WorkspaceRecord]
	eventCount:        uint & <=4294967295
	preservedJournal?: string & !=""
}
