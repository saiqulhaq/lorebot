export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export const LOG_FORMATS = ["pretty", "json"] as const
export type LogFormat = (typeof LOG_FORMATS)[number]

export type LogFields = Record<string, unknown>

export type Logger = {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  child(component: string): Logger
}

const WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export function makeLogger(
  options: { level: LogLevel; format: LogFormat; component?: string },
  write: (line: string) => void = defaultWrite,
): Logger {
  const { level, format, component } = options

  const emit = (entryLevel: LogLevel, message: string, fields?: LogFields) => {
    if (WEIGHT[entryLevel] < WEIGHT[level]) return
    const timestamp = new Date().toISOString()
    if (format === "json") {
      write(
        JSON.stringify({
          ts: timestamp,
          level: entryLevel,
          ...(component ? { component } : {}),
          msg: message,
          ...normalize(fields),
        }),
      )
      return
    }
    const tag = component ? ` [${component}]` : ""
    const suffix = fields && Object.keys(fields).length > 0 ? ` ${formatFields(fields)}` : ""
    write(`${timestamp} ${entryLevel.toUpperCase().padEnd(5)}${tag} ${message}${suffix}`)
  }

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (childComponent) =>
      makeLogger({ level, format, component: component ? `${component}.${childComponent}` : childComponent }, write),
  }
}

function formatFields(fields: LogFields): string {
  return Object.entries(normalize(fields))
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ")
}

/** Make errors serializable and drop undefined values. */
function normalize(fields?: LogFields): LogFields {
  if (!fields) return {}
  const result: LogFields = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    result[key] = value instanceof Error ? `${value.name}: ${value.message}` : value
  }
  return result
}

function defaultWrite(line: string): void {
  console.log(line)
}
