import pino from 'pino'

export const createLogger = () =>
  pino({
    level: process.env.LOG_LEVEL ?? 'info',
  })

export type Logger = pino.Logger
