import type { ModuleCtx, ModuleHealth, ModuleLifecycle } from './types.js'

export interface VehicleData {
  soc: number
  batteryCapacity?: number
  range?: number
  isCharging?: boolean
  /** Target state of charge the car is set to (%). */
  targetSoc?: number
  /** The car's own view of whether a cable is connected — a cross-check independent of OCPP. */
  pluggedIn?: boolean
  /** Remote climate / preconditioning currently running. */
  climateActive?: boolean
  /** Raw charging state enum (CHARGING | CONNECT_CABLE | READY_FOR_CHARGING | CONSERVING | …). */
  state?: string
  chargePowerKw?: number
  remainingChargeMinutes?: number
  fetchedAt: Date
}

/**
 * What signals a vehicle module can provide (static per module; a module may compute it from config).
 * Plan target units and auto-identify eligibility DERIVE from this (see targetUnitsFor/autoIdentifiable
 * in smart-charging/energy.ts) — consumers branch on capabilities, never on the module `type`. A module
 * reporting `presence` (cable-connected via its own API) is eligible for identify-on-plug.
 */
export interface VehicleCapabilities {
  soc: boolean
  range: boolean
  capacity: boolean
  presence: boolean
  climate: boolean
  targetSoc: boolean
}

/** No-telemetry capabilities — a manual / API-less vehicle (kWh-only, never auto-identified). */
export const VEHICLE_CAPS_NONE: VehicleCapabilities = {
  soc: false,
  range: false,
  capacity: false,
  presence: false,
  climate: false,
  targetSoc: false,
}

export interface Vehicle extends ModuleLifecycle {
  readonly id: string
  /** Standardized capability descriptor — what this module can report (drives plan units + auto-ID). */
  readonly capabilities: VehicleCapabilities
  /**
   * Perform ONE live fetch, update the cache, and return the fresh data. The lifecycle decides
   * WHEN to call this (on charger-connect + periodically during charging) — the module owns no
   * background timer of its own. Throws on failure; the caller keeps the last cached value.
   */
  refresh(): Promise<VehicleData>
  /** Last cached data (throws if none fetched yet). Does not hit the network. */
  getData(): Promise<VehicleData>
  getCachedCapacity(): number | undefined
  /**
   * Car-side start-charge — the actuation OSC could not do before (some cars, e.g. the VW-group
   * Enyaq, latch charging OFF at the car and no charger-side OCPP command overrides it). Optional:
   * a module implements it only if the car's cloud API exposes it. The SessionReconciler
   * feature-detects (like the Charger's optional `remoteStart`) and only calls it against an open
   * charging session. Throws on failure; the caller keeps trying its other levers.
   */
  startCharging?(): Promise<void>
  /** Car-side stop-charge — the symmetric optional command. */
  stopCharging?(): Promise<void>
  health(): ModuleHealth
  stop(): Promise<void>
}

/**
 * One user-supplied config field a vehicle module needs, BEYOND the universal `name`. A module
 * self-describes its onboarding/settings form the same way it self-describes its capabilities: this
 * descriptor drives the UI form (UI-agnostic), the generic POST/PUT validation, and secret redaction.
 * A new car API is then a drop-in module — no core or frontend changes to onboard it.
 */
export interface VehicleConfigField {
  /** Config key persisted in the override (e.g. 'username', 'vin'). */
  key: string
  /** Human label for the form field (e.g. 'App email'). */
  label: string
  /** Input kind — 'password' masks the field; defaults to 'text'. */
  type?: 'text' | 'password'
  /** Required when creating the vehicle. */
  required?: boolean
  /** A credential — redacted on export and, on edit, kept when the field is left blank. */
  secret?: boolean
  /** Optional helper text shown under the field. */
  help?: string
  /** Optional anchored regex the value must match (validated client + server side), e.g. VIN length. */
  pattern?: string
}

export interface VehicleModule {
  readonly type: string
  /** Human label for the type picker (e.g. 'Škoda / VW group'). */
  readonly label: string
  /**
   * The config fields this type needs beyond the universal `name` — the module self-describes its
   * onboarding/settings form (see {@link VehicleConfigField}). Empty for a no-config type (manual).
   */
  readonly configFields: VehicleConfigField[]
  /**
   * Static capability preview for the pre-create form + the demo. The CREATED instance's own
   * `capabilities` remains the runtime source of truth; for the current modules the two are identical
   * (config-independent).
   */
  readonly capabilities: VehicleCapabilities
  create(cfg: unknown, ctx: ModuleCtx): Vehicle
}
