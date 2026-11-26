package data_models

#Product: {
	sku:        string & !=""
	name:       string & !=""
	priceCents: uint32
}

#ProductList: {
	products: [...#Product]
}

#OrderRequest: {
	sku:      string & !=""
	quantity: uint32 & >0
}

#OrderAccepted: {
	orderId:  string & !=""
	sku:      string & !=""
	quantity: uint32 & >0
}
