package hobo

#CiFleetHost: {
	provider: "hostinger"
	id: =~"^[1-9][0-9]{0,18}$"
	hostname: string
	state: string & !=""
	plan: string
	ipv4: string
	actionsLock: "" | "unlocked" | "locked"
}

#CiFleetStatus: {
	provider: "hostinger"
	hosts: [...#CiFleetHost]
}

#CiFleetPowerAction: {
	provider: "hostinger"
	host: #CiFleetHost
	action: "restart" | "start"
	actionId: =~"^[1-9][0-9]{0,18}$"
	actionState: string & !=""
}

CiFleetHost: #CiFleetHost
CiFleetStatus: #CiFleetStatus
CiFleetPowerAction: #CiFleetPowerAction
