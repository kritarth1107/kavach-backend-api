/**
 * Per-user private browser profile store.
 * Encrypted Playwright storageState keyed by (familyId, userId).
 */
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import BrowserProfile from "../../models/browserProfile.model";
import { decryptSessionBlob, encryptSessionBlob } from "./sessionStore.service";

export type BrowserProfileRecord = {
    familyId: string;
    userId: string;
    storageStateJson: string | null;
    lastPartner?: string;
    lastUrl?: string;
    diskDir: string;
};

function profileRoot(): string {
    return (
        process.env.BROWSER_PROFILE_DIR?.trim() ||
        path.join(process.cwd(), ".saheli-browser-profiles")
    );
}

export function profileDiskDir(familyId: string, userId: string): string {
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    return path.join(profileRoot(), safe(familyId), safe(userId));
}

export async function getOrCreateBrowserProfile(
    familyId: string,
    userId: string,
): Promise<BrowserProfileRecord> {
    const diskDir = profileDiskDir(familyId, userId);
    try {
        fs.mkdirSync(diskDir, { recursive: true });
    } catch {
        /* ignore */
    }

    let storageStateJson: string | null = null;
    let lastPartner: string | undefined;
    let lastUrl: string | undefined;
    try {
        if (mongoose.connection.readyState !== 1) {
            throw new Error("mongoose not connected");
        }
        let row = await BrowserProfile.findOne({ familyId, userId });
        if (!row) {
            row = await BrowserProfile.create({ familyId, userId });
        }
        if (row.encryptedStorageState) {
            storageStateJson = decryptSessionBlob(row.encryptedStorageState);
        }
        lastPartner = row.lastPartner;
        lastUrl = row.lastUrl;
    } catch (err) {
        console.warn(
            "browser profile mongo unavailable — disk-only:",
            err instanceof Error ? err.message : err,
        );
    }

    // Also try disk file as fallback / sync for local Chromium
    const diskState = path.join(diskDir, "storageState.json");
    if (!storageStateJson && fs.existsSync(diskState)) {
        try {
            storageStateJson = fs.readFileSync(diskState, "utf8");
        } catch {
            /* ignore */
        }
    }

    return {
        familyId,
        userId,
        storageStateJson,
        lastPartner,
        lastUrl,
        diskDir,
    };
}

export async function saveBrowserProfileState(input: {
    familyId: string;
    userId: string;
    storageStateJson: string;
    lastPartner?: string;
    lastUrl?: string;
}): Promise<void> {
    const encrypted = encryptSessionBlob(input.storageStateJson);
    const diskDir = profileDiskDir(input.familyId, input.userId);
    try {
        fs.mkdirSync(diskDir, { recursive: true });
        fs.writeFileSync(path.join(diskDir, "storageState.json"), input.storageStateJson, {
            mode: 0o600,
        });
    } catch (err) {
        console.warn(
            "browser profile disk write failed:",
            err instanceof Error ? err.message : err,
        );
    }

    try {
        if (mongoose.connection.readyState !== 1) {
            throw new Error("mongoose not connected");
        }
        await BrowserProfile.findOneAndUpdate(
            { familyId: input.familyId, userId: input.userId },
            {
                $set: {
                    encryptedStorageState: encrypted ?? undefined,
                    lastPartner: input.lastPartner,
                    lastUrl: input.lastUrl,
                    lastUsedAt: new Date(),
                },
            },
            { upsert: true },
        );
    } catch (err) {
        console.warn(
            "browser profile mongo save failed:",
            err instanceof Error ? err.message : err,
        );
    }
}
