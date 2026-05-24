import { EventEmitter } from 'node:events'

export type EventBus = EventEmitter & {
  emit(event: string | symbol, ...args: unknown[]): boolean
}

export function createEventBus(): EventBus {
  const bus = new EventEmitter()

  const originalEmit = bus.emit.bind(bus)

  bus.emit = (event: string | symbol, ...args: unknown[]): boolean => {
    const result = originalEmit(event, ...args)
    // Broadcast every named event to the wildcard listener used by SSE
    if (event !== '*') {
      originalEmit('*', event, ...args)
    }
    return result
  }

  return bus as EventBus
}
