import type { ModuleHealth } from '@sdk/types.js'
import type { ChargeMode } from '@sdk/balancer.js'

// Over-the-wire shapes (Dates serialized to ISO strings)

export type { ModuleHealth, ChargeMode }

export interface LoadpointStateDto {
  name: string
  mode: ChargeMode
  targetSoc?: number
  targetTime?: string
  targetKWh?: number
  connected: boolean
  charging: boolean
  currentA: number
  sessionEnergyKWh: number
  maxCurrentA: number
  autoStart: boolean
}

export interface TariffSlotDto {
  start: string
  end: string
  pricePerKWh: number
  currency: string
}

export interface BalancerStateDto {
  name: string
  health: ModuleHealth
  lastAllocations: Record<string, number> | null
  freeAmps: number | null
}

export interface VehicleDataDto {
  soc: number
  batteryCapacity?: number
  range?: number
  isCharging?: boolean
  fetchedAt: string
}

export interface VehicleStateDto {
  name: string
  health: ModuleHealth
  data: VehicleDataDto | null
  capacityKWh: number | null
}

export interface MeterStateDto {
  latest: {
    powerW?: number
    i1A?: number
    i2A?: number
    i3A?: number
    timestamp: string
  } | null
  health: ModuleHealth
}

export interface TransactionDto {
  id: number
  loadpoint_name: string
  station_id: string
  start_time: string
  end_time: string | null
  energy_kwh: number | null
  id_tag: string | null
}

export interface MeterSampleDto {
  measured_at: string
  energy_kwh: number | null
  power_w: number | null
  current_a: number | null
  soc: number | null
}

export interface TransactionDetailDto {
  transaction: TransactionDto
  samples: MeterSampleDto[]
}

export interface SiteLoadpointDto {
  name: string
  charger: string
  balancer?: string
  tariff?: string
  vehicle?: string
  maxCurrentA: number
  autoStart: boolean
  targetSoc?: number
  targetTime?: string
  targetKWh?: number
}

export interface SiteChargerDto {
  name: string
  type: string
  stationId?: string
  maxA: number
}
export interface SiteBalancerDto {
  name: string
  type: string
  mainBreakerA: number
  phases: number
}
export interface SiteTariffDto {
  name: string
  type: string
  zone?: string
}
export interface SiteVehicleDto {
  name: string
  type: string
  vin?: string
}
export interface SiteMeterDto {
  name: string
  type: string
}

export interface SiteDto {
  site: { name: string; port: number }
  loadpoints: SiteLoadpointDto[]
  chargers: SiteChargerDto[]
  balancers: SiteBalancerDto[]
  tariffs: SiteTariffDto[]
  vehicles: SiteVehicleDto[]
  meterReaders: SiteMeterDto[]
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`)
  return res.json() as Promise<T>
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const getLoadpoints = () => apiFetch<LoadpointStateDto[]>('/api/loadpoints')
export const getLoadpoint = (name: string) => apiFetch<LoadpointStateDto>(`/api/loadpoints/${name}`)
export const setMode = (name: string, mode: ChargeMode) =>
  apiFetch<LoadpointStateDto>(`/api/loadpoints/${name}/mode`, json({ mode }))
export const setTarget = (name: string, soc?: number, time?: string, kwh?: number) =>
  apiFetch<LoadpointStateDto>(`/api/loadpoints/${name}/target`, json({ soc, time, kwh }))
export const remoteStart = (name: string) =>
  apiFetch<LoadpointStateDto>(`/api/loadpoints/${name}/start`, { method: 'POST' })
export const remoteStop = (name: string) =>
  apiFetch<LoadpointStateDto>(`/api/loadpoints/${name}/stop`, { method: 'POST' })
export const setProfile = (name: string, amps: number) =>
  apiFetch<LoadpointStateDto>(`/api/loadpoints/${name}/profile`, json({ amps }))

export const getTariffPrices = (name: string, from: Date, to: Date) =>
  apiFetch<TariffSlotDto[]>(
    `/api/tariffs/${name}/prices?from=${from.toISOString()}&to=${to.toISOString()}`,
  )

export const getBalancer = (name: string) => apiFetch<BalancerStateDto>(`/api/balancers/${name}`)
export const getVehicle = (name: string) => apiFetch<VehicleStateDto>(`/api/vehicles/${name}`)
export const getMeter = (name: string) => apiFetch<MeterStateDto>(`/api/meters/${name}`)
export const getHealth = () => apiFetch<Record<string, ModuleHealth>>('/api/health')

export const getTransactions = (opts?: { loadpoint?: string; limit?: number }) => {
  const params = new URLSearchParams()
  if (opts?.loadpoint) params.set('loadpoint', opts.loadpoint)
  if (opts?.limit) params.set('limit', String(opts.limit))
  const qs = params.size > 0 ? `?${params}` : ''
  return apiFetch<TransactionDto[]>(`/api/transactions${qs}`)
}
export const getTransaction = (id: number) =>
  apiFetch<TransactionDetailDto>(`/api/transactions/${id}`)
export const getSite = () => apiFetch<SiteDto>('/api/site')
