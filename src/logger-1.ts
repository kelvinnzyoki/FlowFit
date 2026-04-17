import winston from 'winston';

const levels = { error: 0, warn: 1, info: 2, http: 3, debug: 4 };

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
  levels,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
    winston.format.json()
  ),
  transports: [
    // Console only — do not add File transport (not supported on Vercel)
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize({ all: true }),
        winston.format.printf((info) => `${info.timestamp} ${info.level}: ${info.message}`)
      ),
    }),
  ],
});

export const morganStream = {
  write: (message: string) => logger.http(message.trim()),
};

export default logger;
