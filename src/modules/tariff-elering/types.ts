export interface EleringPriceRecord {
  timestamp: number // Unix epoch seconds (UTC)
  price: number // EUR/MWh
}

export interface EleringResponse {
  success: boolean
  data: Record<string, EleringPriceRecord[]>
}
