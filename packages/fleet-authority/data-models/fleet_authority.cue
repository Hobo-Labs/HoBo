// CUE constraints for every protobuf type in data-models/fleet_authority.proto.
package data_models

import (
	"list"
)

#FleetAuthorityConfig: {
	issuer:  string & =~"^https://[^\\s]+$"
	profile: "standalone" | "high-availability"
	natsUrls: [...string & =~"^(tls|wss|nats)://[^\\s]+$"] & list.MinItems(1)
	relayUrls: [...string & =~"^https://[^\\s]+$"]
	minAgentVersion: string & =~"^[0-9]+\\.[0-9]+\\.[0-9]+$"
}

// Root definition for fixture vetting.
#FleetAuthority: #FleetAuthorityConfig
