import { EventEmitter } from 'node:events'

export type EventBus = EventEmitter

export const createEventBus = (): EventBus => new EventEmitter()
