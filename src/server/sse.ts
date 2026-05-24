import type { Request, Response } from 'express'
import type { EventBus } from '../core/events.js'

export function createSseHandler(events: EventBus) {
  return (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    const listener = (eventName: string | symbol, payload: unknown) => {
      res.write(`event: ${String(eventName)}\ndata: ${JSON.stringify(payload ?? null)}\n\n`)
    }

    events.on('*', listener)

    // Heartbeat every 30s to keep proxies from closing idle connections
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n')
    }, 30_000)

    req.on('close', () => {
      clearInterval(heartbeat)
      events.off('*', listener)
    })
  }
}
