package data_models

#OrderCommand: {
	orderId: string & !=""
}

#OrderReceipt: {
	orderId:  string & !=""
	tokenRef: string & !=""
}
