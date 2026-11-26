package data_models

import (
	"strings"
	"strconv"
)

#BudgetFencedPlacement: {
	yardId:            string & !=""
	campId:            string & !=""
	providerId:        string & !=""
	providerAccountId: string & !=""
	resourceId:        string & !=""
	deploymentId:      string & !=""
	incarnationId:     string & !=""
	manifestHash:      =~"^sha256:[a-f0-9]{64}$" & strings.MaxRunes(71)
	planHash:          =~"^sha256:[a-f0-9]{64}$" & strings.MaxRunes(71)
}
#BudgetFenceSettlementGuard: {
	contract:                "hobo.budget-fence-guard/v1"
	dataset:                 string & !=""
	scopeTenant?:            string & strings.MaxRunes(512)
	operationId:             string & !=""
	fenceTokenDigest:        =~"^sha256:[a-f0-9]{64}$" & strings.MaxRunes(71)
	receiverKeyId:           string & !=""
	receiverPublicKey:       string & !=""
	financeKeyId:            string & !=""
	financePublicKey:        string & !=""
	logicalCampId:           string & !=""
	source:                  #BudgetFencedPlacement
	destination:             #BudgetFencedPlacement
	decision:                "to-target" | "to-source"
	executionDigest:         =~"^sha256:[a-f0-9]{64}$" & strings.MaxRunes(71)
	routeDigest:             =~"^sha256:[a-f0-9]{64}$" & strings.MaxRunes(71)
	expectedRouteGeneration: =~"^(0|[1-9][0-9]{0,19})$" & strings.MaxRunes(20)
	_routeGenerationValue:   strconv.ParseUint(expectedRouteGeneration, 10, 64)
	currentSetId:            string & !=""
	desiredSetId:            string & !=""
	migrationId:             string & !=""
	decisionHead:            =~"^[1-9][0-9]{0,19}$" & strings.MaxRunes(20)
	_decisionHeadValue:      strconv.ParseUint(decisionHead, 10, 64) & >0
}
