package data_models

import (
	"strings"
)

#FleetAgentConfig: {
	home:     string & strings.MinRunes(1)
	keystore: "file" | =~"^external-signer:.+$"
	fleets: [...string & =~"^[a-z0-9][a-z0-9_-]{0,62}$"]
	sandboxCap?: "" | "S0" | "S1" | "S2" | "S3"
	transports: [...("p2p" | "overlay" | "bus-relay")]
}

#FleetAgent: #FleetAgentConfig
