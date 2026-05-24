import type { ChargerModule } from './charger.js'
import type { TariffModule } from './tariff.js'
import type { BalancerModule } from './balancer.js'
import type { VehicleModule } from './vehicle.js'
import type { MeterReaderModule } from './meter-reader.js'

const chargerRegistry = new Map<string, ChargerModule>()
const tariffRegistry = new Map<string, TariffModule>()
const balancerRegistry = new Map<string, BalancerModule>()
const vehicleRegistry = new Map<string, VehicleModule>()
const meterReaderRegistry = new Map<string, MeterReaderModule>()

export const registerCharger = (m: ChargerModule) => chargerRegistry.set(m.type, m)
export const registerTariff = (m: TariffModule) => tariffRegistry.set(m.type, m)
export const registerBalancer = (m: BalancerModule) => balancerRegistry.set(m.type, m)
export const registerVehicle = (m: VehicleModule) => vehicleRegistry.set(m.type, m)
export const registerMeterReader = (m: MeterReaderModule) => meterReaderRegistry.set(m.type, m)

export const getChargerModule = (type: string) => chargerRegistry.get(type)
export const getTariffModule = (type: string) => tariffRegistry.get(type)
export const getBalancerModule = (type: string) => balancerRegistry.get(type)
export const getVehicleModule = (type: string) => vehicleRegistry.get(type)
export const getMeterReaderModule = (type: string) => meterReaderRegistry.get(type)
