import { readFileSync } from "fs";
import { join } from "path";
import os from "os";
import mongoose from "mongoose";
import config from "../config/app.config";

const READY_STATES: Record<number, string> = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting",
};

let prevCpu = process.cpuUsage();
let prevCpuTime = process.hrtime.bigint();
const startedAt = Date.now();

interface BuildInfoFile {
    gitCommit?: string;
    gitBranch?: string;
    buildTime?: string;
    imageTag?: string;
    appVersion?: string;
}

function loadBuildInfoFile(): BuildInfoFile {
    const candidates = [
        join(__dirname, "../../build-info.json"),
        join(__dirname, "../build-info.json"),
    ];

    for (const filePath of candidates) {
        try {
            return JSON.parse(readFileSync(filePath, "utf8")) as BuildInfoFile;
        } catch {
            // try next path
        }
    }

    return {};
}

const buildInfoFile = loadBuildInfoFile();

function getAppVersion(): string {
    if (buildInfoFile.appVersion) {
        return buildInfoFile.appVersion;
    }

    try {
        const pkg = JSON.parse(
            readFileSync(join(__dirname, "../../package.json"), "utf8"),
        ) as { version?: string };
        return pkg.version ?? "unknown";
    } catch {
        return "unknown";
    }
}

function getBuildMetadata() {
    const gitCommit =
        process.env.GIT_COMMIT_SHA ?? buildInfoFile.gitCommit ?? "unknown";

    return {
        gitCommit,
        gitCommitShort: gitCommit === "unknown" ? "unknown" : gitCommit.slice(0, 7),
        gitBranch: process.env.GIT_BRANCH ?? buildInfoFile.gitBranch ?? "unknown",
        buildTime:
            process.env.BUILD_TIME ||
            buildInfoFile.buildTime ||
            "unknown",
        imageTag: process.env.IMAGE_TAG ?? buildInfoFile.imageTag ?? "unknown",
    };
}

function parseMongoTarget(uri: string): { scheme: string; host: string; database: string } {
    const match = uri.match(/^mongodb(\+srv)?:\/\/(?:[^@]+@)?([^/?]+)(?:\/([^?]*))?/);
    if (!match) {
        return { scheme: "mongodb", host: "unknown", database: "unknown" };
    }

    return {
        scheme: match[1] ? "mongodb+srv" : "mongodb",
        host: match[2],
        database: match[3]?.split("?")[0] || "unknown",
    };
}

function formatBytes(bytes: number): string {
    if (bytes < 1024 * 1024) {
        return `${Math.round(bytes / 1024)} KB`;
    }
    if (bytes < 1024 * 1024 * 1024) {
        return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
    }
    return `${Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10} GB`;
}

function getProcessCpuPercent(): number {
    const currentCpu = process.cpuUsage();
    const currentTime = process.hrtime.bigint();
    const elapsedMicros = Number(currentTime - prevCpuTime) / 1000;
    const userDelta = currentCpu.user - prevCpu.user;
    const systemDelta = currentCpu.system - prevCpu.system;
    prevCpu = currentCpu;
    prevCpuTime = currentTime;

    if (elapsedMicros <= 0) {
        return 0;
    }

    const cores = os.cpus().length || 1;
    const percent = ((userDelta + systemDelta) / elapsedMicros / cores) * 100;
    return Math.round(Math.max(0, percent) * 100) / 100;
}

async function getMongoHealth() {
    const target = parseMongoTarget(config.database.uri);
    const readyState = mongoose.connection.readyState;
    const status = READY_STATES[readyState] ?? "unknown";

    const base = {
        status,
        readyState,
        target: {
            scheme: target.scheme,
            host: target.host,
            database: target.database,
            connectedHost: mongoose.connection.host || null,
            connectedPort: mongoose.connection.port || null,
            connectedDb: mongoose.connection.name || null,
        },
    };

    if (readyState !== 1 || !mongoose.connection.db) {
        return {
            ...base,
            ping: {
                ok: false,
                latencyMs: null,
                error: "MongoDB is not connected",
            },
        };
    }

    const pingStarted = Date.now();
    try {
        await mongoose.connection.db.admin().command({ ping: 1 });
        return {
            ...base,
            ping: {
                ok: true,
                latencyMs: Date.now() - pingStarted,
                error: null,
            },
        };
    } catch (error) {
        return {
            ...base,
            ping: {
                ok: false,
                latencyMs: Date.now() - pingStarted,
                error: error instanceof Error ? error.message : "Ping failed",
            },
        };
    }
}

export async function buildBasicHealthReport() {
    const mongo = await getMongoHealth();
    const overallOk = mongo.status === "connected" && mongo.ping.ok;

    return {
        status: overallOk ? "ok" : "degraded",
        message: overallOk
            ? "Kavach Backend is running"
            : "Kavach Backend is running with dependency issues",
        checkedAt: new Date().toISOString(),
        service: {
            name: "kavach-backend",
            version: getAppVersion(),
            environment: process.env.NODE_ENV ?? "development",
            uptimeSeconds: Math.round(process.uptime()),
        },
        dependencies: {
            mongodb: {
                status: mongo.status,
                ping: mongo.ping.ok,
            },
        },
    };
}

export async function buildHealthReport() {
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const mongo = await getMongoHealth();
    const overallOk = mongo.status === "connected" && mongo.ping.ok;

    return {
        status: overallOk ? "ok" : "degraded",
        message: overallOk
            ? "Kavach Backend is running"
            : "Kavach Backend is running with dependency issues",
        checkedAt: new Date().toISOString(),
        service: {
            name: "kavach-backend",
            version: getAppVersion(),
            environment: process.env.NODE_ENV ?? "development",
            uptimeSeconds: Math.round(process.uptime()),
            startedAt: new Date(startedAt - process.uptime() * 1000).toISOString(),
        },
        build: getBuildMetadata(),
        runtime: {
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            pid: process.pid,
            hostname: os.hostname(),
            containerApp: {
                name: process.env.CONTAINER_APP_NAME ?? null,
                revision: process.env.CONTAINER_APP_REVISION ?? null,
                replicaName: process.env.CONTAINER_APP_REPLICA_NAME ?? null,
                envDnsSuffix: process.env.CONTAINER_APP_ENV_DNS_SUFFIX ?? null,
            },
        },
        system: {
            cpu: {
                cores: os.cpus().length,
                model: os.cpus()[0]?.model ?? "unknown",
                loadAverage: os.loadavg().map((v) => Math.round(v * 100) / 100),
                processUsagePercent: getProcessCpuPercent(),
            },
            memory: {
                process: {
                    rss: mem.rss,
                    rssFormatted: formatBytes(mem.rss),
                    heapUsed: mem.heapUsed,
                    heapUsedFormatted: formatBytes(mem.heapUsed),
                    heapTotal: mem.heapTotal,
                    heapTotalFormatted: formatBytes(mem.heapTotal),
                    external: mem.external,
                },
                host: {
                    total: totalMem,
                    totalFormatted: formatBytes(totalMem),
                    free: freeMem,
                    freeFormatted: formatBytes(freeMem),
                    usedPercent: Math.round(((totalMem - freeMem) / totalMem) * 10000) / 100,
                },
            },
            uptimeSeconds: Math.round(os.uptime()),
        },
        dependencies: {
            mongodb: mongo,
        },
    };
}
