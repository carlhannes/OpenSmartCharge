// Narrow subset of OCPP 1.6J message shapes we actually use

export interface BootNotificationReq {
  chargePointVendor: string
  chargePointModel: string
  chargePointSerialNumber?: string
  firmwareVersion?: string
}

export interface StatusNotificationReq {
  connectorId: number
  errorCode: string
  status: string
  timestamp?: string
  info?: string
  vendorId?: string
  vendorErrorCode?: string
}

export interface MeterValuesReq {
  connectorId: number
  transactionId?: number
  meterValue: MeterValue[]
}

export interface MeterValue {
  timestamp: string
  sampledValue: SampledValue[]
}

export interface SampledValue {
  value: string
  context?: string
  format?: string
  measurand?: string
  phase?: string
  location?: string
  unit?: string
}

export interface StartTransactionReq {
  connectorId: number
  idTag: string
  meterStart: number
  timestamp: string
  reservationId?: number
}

export interface StopTransactionReq {
  transactionId: number
  meterStop: number
  timestamp: string
  idTag?: string
  reason?: string
  transactionData?: MeterValue[]
}

export interface AuthorizeReq {
  idTag: string
}

// SetChargingProfile payload (TxDefaultProfile/Absolute)
export interface SetChargingProfileReq {
  connectorId: number
  csChargingProfiles: {
    chargingProfileId: number
    stackLevel: number
    chargingProfilePurpose: 'TxDefaultProfile' | 'TxProfile' | 'ChargePointMaxProfile'
    chargingProfileKind: 'Absolute' | 'Relative' | 'Recurring'
    chargingSchedule: {
      startSchedule?: string
      chargingRateUnit: 'A' | 'W'
      chargingSchedulePeriod: Array<{ startPeriod: number; limit: number; numberPhases?: number }>
    }
  }
}

export interface RemoteStartTransactionReq {
  connectorId?: number
  idTag: string
}

export interface RemoteStopTransactionReq {
  transactionId: number
}
