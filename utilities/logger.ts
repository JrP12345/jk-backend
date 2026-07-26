import crypto from "node:crypto";

export interface LogContext {
  traceId?: string;
  spanId?: string;
  correlationId?: string;
  tenantId?: string;
  userId?: string;
  service?: string;
}

export class Logger {
  private serviceName: string;

  constructor(serviceName = "ananta-backend") {
    this.serviceName = serviceName;
  }

  private formatMessage(level: "INFO" | "WARN" | "ERROR" | "DEBUG", message: string, context: LogContext = {}, extra: Record<string, any> = {}) {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      service: context.service || this.serviceName,
      traceId: context.traceId || crypto.randomUUID(),
      spanId: context.spanId || crypto.randomUUID().substring(0, 16),
      correlationId: context.correlationId || context.traceId,
      tenantId: context.tenantId || null,
      userId: context.userId || null,
      message,
      extra: Object.keys(extra).length > 0 ? extra : undefined,
    });
  }

  info(message: string, context?: LogContext, extra?: Record<string, any>) {
    console.log(this.formatMessage("INFO", message, context, extra));
  }

  warn(message: string, context?: LogContext, extra?: Record<string, any>) {
    console.warn(this.formatMessage("WARN", message, context, extra));
  }

  error(message: string, context?: LogContext, extra?: Record<string, any>) {
    console.error(this.formatMessage("ERROR", message, context, extra));
  }

  debug(message: string, context?: LogContext, extra?: Record<string, any>) {
    console.debug(this.formatMessage("DEBUG", message, context, extra));
  }
}

export const logger = new Logger();
