/**
 * Drop all Cosmos (MongoDB API) collections and recreate Cosmos-safe indexes.
 *
 * Usage:
 *   npx tsx scripts/reset-cosmos-db.ts
 *   npx tsx scripts/reset-cosmos-db.ts --yes   # skip confirmation
 */
import "dotenv/config";
import mongoose from "mongoose";
import readline from "readline";

import User from "../src/models/users.model";
import Family from "../src/models/family.model";
import FamilyInvitation from "../src/models/familyInvitation.model";
import Session from "../src/models/session.model";
import CareSchedule from "../src/models/careSchedule.model";
import AiTenant from "../src/models/aiTenant.model";

const MODELS = [User, Family, FamilyInvitation, Session, CareSchedule, AiTenant];

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            const wait = 800 * (i + 1);
            console.warn(`  retry ${label} (${i + 1}/${attempts}) after ${wait}ms`);
            await sleep(wait);
        }
    }
    throw lastError;
}

async function confirm(message: string): Promise<boolean> {
    if (process.argv.includes("--yes")) {
        return true;
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        rl.question(`${message} Type "yes" to continue: `, (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase() === "yes");
        });
    });
}

async function main() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        throw new Error("MONGODB_URI is not set");
    }

    const hostHint = uri.includes("@") ? uri.split("@")[1]?.split("/")[0] : uri;
    console.log(`Target: ${hostHint}`);

    const ok = await confirm(
        "This will DELETE ALL data in every MongoDB collection. ",
    );
    if (!ok) {
        console.log("Aborted.");
        process.exit(0);
    }

    await mongoose.connect(uri);
    const db = mongoose.connection.db;
    if (!db) {
        throw new Error("No database connection");
    }

    const collections = await db.listCollections().toArray();
    console.log(`\nDropping ${collections.length} collection(s)...`);

    for (const coll of collections) {
        const name = coll.name;
        if (name.startsWith("system.")) {
            continue;
        }
        await withRetry(`drop ${name}`, () => db.dropCollection(name));
        console.log(`  dropped ${name}`);
        await sleep(400);
    }

    console.log("\nRecreating indexes from Mongoose schemas...");
    for (const model of MODELS) {
        const name = model.collection.name;
        await withRetry(`create ${name}`, async () => {
            await model.createCollection();
            await model.syncIndexes();
        });
        const indexes = await model.collection.indexes();
        console.log(`  ${name}: ${indexes.map((i) => i.name).join(", ")}`);
        await sleep(600);
    }

    console.log("\nDone. Database is empty with fresh Cosmos-safe indexes.");
    await mongoose.disconnect();
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
