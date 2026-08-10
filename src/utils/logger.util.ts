import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';

// Ensure standard log directories exist securely at the root level
const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

// Define comprehensive standardized JSON structure exclusively for file logs
const fileLogFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Define readable, colored console format specifically for developers
const consoleLogFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.printf(({ level, message, timestamp, ...meta }) => {
    return `[${timestamp}] ${level}: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
  })
);

/**
 * Robust Logging Utility to manage and track all systemic actions
 */
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info', // Allow level injection
  transports: [
    // Standard console output for immediate insight
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        consoleLogFormat
      )
    }),
    
    // Dedicated 30-day rotation solely for HIGH SEVERITY ERRORS
    new DailyRotateFile({
      dirname: path.join(logDir, 'error'),
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxFiles: '30d',
      format: fileLogFormat
    }),
    
    // Ultimate comprehensive 90-day rotation encompassing Every single event (Requests, Logins, Failures)
    new DailyRotateFile({
      dirname: path.join(logDir, 'audit'),
      filename: 'audit-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '90d',
      format: fileLogFormat
    })
  ]
});

export default logger;
