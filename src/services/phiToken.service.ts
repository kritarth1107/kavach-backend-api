import { createHash, randomUUID } from "crypto";
import PersonToken from "../models/personToken.model";

const PHONE_RE = /(?:\+91[\s-]?)?[6-9]\d{9}/g;
const AADHAAR_LIKE_RE = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function hashValue(value: string): string {
    return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

async function getOrCreateToken(
    familyId: string,
    tokenType: IPersonTokenType,
    raw: string,
): Promise<string> {
    const tokenHash = hashValue(raw);
    let existing = await PersonToken.findOne({ familyId, tokenHash }).lean();
    if (!existing) {
        const created = await PersonToken.create({
            tokenId: randomUUID(),
            familyId,
            tokenType,
            tokenHash,
        });
        return `phi:${tokenType}:${created.tokenId.slice(0, 8)}`;
    }
    return `phi:${tokenType}:${existing.tokenId.slice(0, 8)}`;
}

type IPersonTokenType = "phone" | "address" | "aadhaar_like" | "email" | "name";

export async function tokenizePhiInText(
    familyId: string,
    text: string,
): Promise<{ text: string; phiTokenRefs: string[] }> {
    let out = text;
    const refs: string[] = [];

    const replacements: Array<{ pattern: RegExp; type: IPersonTokenType }> = [
        { pattern: PHONE_RE, type: "phone" },
        { pattern: AADHAAR_LIKE_RE, type: "aadhaar_like" },
        { pattern: EMAIL_RE, type: "email" },
    ];

    for (const { pattern, type } of replacements) {
        const matches = [...new Set(text.match(pattern) ?? [])];
        for (const match of matches) {
            const token = await getOrCreateToken(familyId, type, match);
            refs.push(token);
            out = out.split(match).join(token);
        }
    }

    return { text: out, phiTokenRefs: refs };
}

export function detokenizeForDisplay(text: string): string {
    return text.replace(/phi:[a-z_]+:[a-f0-9]{8}/gi, "[redacted]");
}
