/**
 * Application Configuration Types - TypeScript interfaces for application configuration
 * This file defines the TypeScript interfaces for all configuration settings
 * including server, database, security, and other application parameters
 */

/**
 * Server configuration interface
 * Defines settings for the Express server including port, environment, and CORS
 */
export interface ServerConfig {
    port: number;                    // Server port number
    env: string;                     // Environment (development/production/test)
    apiVersion: string;              // API version string
    corsOrigins: string[];           // Array of allowed CORS origins
    liveFrontendUrl: string;         // Live frontend URL
}

/**
 * JWT configuration interface
 * Defines settings for JSON Web Token authentication
 */
export interface JWTConfig {
    secret: string;      // JWT signing secret key
    nextSecret:string;
    validity: string;                // Token validity period (e.g., "24h")
}

/**
 * Database configuration interface
 * Defines MongoDB connection settings and options
 */
export interface DatabaseConfig {
    uri: string;                     // MongoDB connection URI
    options: {
        useNewUrlParser: boolean;    // Use new URL parser (deprecated but kept for compatibility)
        useUnifiedTopology: boolean; // Use unified topology engine
    };
}


/**
 * Security configuration interface
 * Defines security-related settings including password hashing and rate limiting
 */
export interface SecurityConfig {
    bcryptSaltRounds: number;        // Number of salt rounds for bcrypt password hashing
    rateLimiting: {
        windowMs: number;            // Rate limiting window in milliseconds
        max: number;                 // Maximum requests per window per IP
    };
}


/**
 * Logging configuration interface
 * Defines logging settings and file configuration
 */
export interface LoggingConfig {
    level: string;                   // Logging level (error, warn, info, debug)
    filename: string;                // Log file name
}

/**
 * Encryption configuration interface
 * Defines AES encryption settings for sensitive data
 */
export interface EncryptionConfig {
    secretKey: string | undefined;   // AES encryption secret key
    ivLength: number;                // Initialization vector length
    inviteSecret?: string;           // Invite secret for generating codes
}



/**
 * Email configuration interface
 * Defines email settings for sending emails
 */
export interface EmailConfig {
    resendApiKey: string;            // Resend API Key
    from: string;                    // Sender email address
}

/**
 * Cloudflare R2 configuration interface
 * Defines settings for Cloudflare R2 object storage
 */
export interface R2Config {
    endpoint: string;                // R2 endpoint URL
    accessKeyId: string;             // R2 access key ID
    secretAccessKey: string;       // R2 secret access key
    bucketName: string;              // R2 bucket name
    publicUrl: string;               // Public URL for accessing files
}


export interface AiEngineConfig {
    baseUrl: string;
    apiSecret: string;
    timeoutMs: number;
    writeTimeoutMs: number;
}

export interface HealthConfig {
    secret: string;
}

/**
 * Main application configuration interface
 * Combines all configuration interfaces into a single configuration object
 * This is the root interface used by the application configuration
 */
export interface AppConfig {
    server: ServerConfig;            // Server configuration settings
    jwt: JWTConfig;                  // JWT authentication settings
    database: DatabaseConfig;        // Database connection settings
    security: SecurityConfig;        // Security and authentication settings
    logging: LoggingConfig;          // Logging configuration
    encryption: EncryptionConfig;    // Encryption settings
    email: EmailConfig;              // Email settings
    r2: R2Config;                    // Cloudflare R2 settings
    aiEngine: AiEngineConfig;        // Kawach AI engine (Saheli / RAG)
    health: HealthConfig;              // Protected health endpoint settings
}