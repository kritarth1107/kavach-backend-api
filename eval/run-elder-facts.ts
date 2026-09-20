/**
 * Offline eval for elder Saheli facts layer + reply guard (no live AI / DB).
 * Run: npm run eval:elder-facts
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
    buildCasualOfferReply,
    messageAsksHelp,
    messageAsksSchedule,
    messageIsCasualOffer,
    tryHandleElderScheduleQuery,
} from "../src/services/saheliElderFacts.service";
import { guardElderReply } from "../src/services/saheliReplyGuard.service";
import { messageLooksLikeOrder } from "../src/services/saheliOrder.service";
import type { SaheliContextBundle } from "../src/services/saheliContext.service";
import type { SaheliReplySource } from "../src/services/whatsappWebhookLog.service";

type ElderFactsCase = {
    message: string;
    expect_path?: SaheliReplySource;
    expect_contains?: string[];
    forbid?: string[];
    reply_source?: SaheliReplySource;
    mock_schedule?: {
        missed?: Array<{ time: string; title: string; dosage?: string }>;
        upcoming?: Array<{ time: string; title: string; dosage?: string }>;
    };
    guard?: {
        ai_reply: string;
        tool_trace?: Array<{ tool: string; status?: string }>;
        expect_guard?: string;
        forbid?: string[];
    };
};

function loadCases(): ElderFactsCase[] {
    const path = join(__dirname, "fixtures", "elder_order_cases.jsonl");
    return readFileSync(path, "utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ElderFactsCase);
}

function mockContext(mock?: ElderFactsCase["mock_schedule"]): SaheliContextBundle {
    const item = (row: { time: string; title: string; dosage?: string }) => ({
        scheduleId: "s1",
        time: row.time,
        title: row.title,
        dosage: row.dosage,
        status: "pending" as const,
        type: "medicine" as const,
    });
    return {
        dateKey: "2026-09-20",
        schedule: [],
        missed: (mock?.missed ?? []).map(item),
        upcoming: (mock?.upcoming ?? []).map(item),
        completed: [],
        due: [],
        adherencePercent: null,
        lastHeardLine: null,
        lastHeardAt: null,
        lastCheckInAt: null,
        careRecordContext: "",
        companionProfile: {},
        connectedPartners: { swiggy: false, instamart: false, zepto: false },
        defaultAddressCount: 0,
    };
}

function resolvePreAiPath(message: string): SaheliReplySource {
    if (messageIsCasualOffer(message)) return "scheduleFacts";
    if (messageAsksSchedule(message)) return "scheduleFacts";
    if (messageAsksHelp(message)) return "scheduleFacts";
    if (messageLooksLikeOrder(message)) return "orderComms";
    return "ai";
}

function scoreText(reply: string, expect?: string[], forbid?: string[]): string[] {
    const reasons: string[] = [];
    const lower = reply.toLowerCase();
    for (const token of expect ?? []) {
        if (!lower.includes(token.toLowerCase())) {
            reasons.push(`missing '${token}'`);
        }
    }
    for (const token of forbid ?? []) {
        if (lower.includes(token.toLowerCase())) {
            reasons.push(`forbidden '${token}'`);
        }
    }
    return reasons;
}

async function runCase(caseRow: ElderFactsCase): Promise<string[]> {
    const reasons: string[] = [];

    if (caseRow.expect_path) {
        const path = resolvePreAiPath(caseRow.message);
        if (path !== caseRow.expect_path) {
            reasons.push(`expected path ${caseRow.expect_path}, got ${path}`);
        }
    }

    if (messageAsksSchedule(caseRow.message) || messageIsCasualOffer(caseRow.message)) {
        let reply: string;
        if (messageIsCasualOffer(caseRow.message)) {
            reply = buildCasualOfferReply("Amma");
        } else {
            const scheduleReply = tryHandleElderScheduleQuery({
                message: caseRow.message,
                context: mockContext(caseRow.mock_schedule),
            });
            reply = scheduleReply ?? "";
        }
        reasons.push(...scoreText(reply, caseRow.expect_contains, caseRow.forbid));
        if (caseRow.reply_source && messageIsCasualOffer(caseRow.message)) {
            if (caseRow.reply_source !== "scheduleFacts") {
                reasons.push(`expected reply_source scheduleFacts`);
            }
        }
    }

    if (caseRow.guard) {
        const guarded = await guardElderReply({
            message: caseRow.message,
            reply: caseRow.guard.ai_reply,
            replySource: "ai",
            toolTrace: caseRow.guard.tool_trace,
            familyId: "mock-family",
            recipientUserId: "mock-recipient",
            displayName: "Amma",
        });
        if (caseRow.guard.expect_guard && guarded.guardAction !== caseRow.guard.expect_guard) {
            reasons.push(
                `guard expected ${caseRow.guard.expect_guard}, got ${guarded.guardAction ?? "none"}`,
            );
        }
        reasons.push(...scoreText(guarded.reply, caseRow.expect_contains, caseRow.guard.forbid));
    }

    return reasons;
}

async function main(): Promise<number> {
    const cases = loadCases();
    let passed = 0;
    for (const caseRow of cases) {
        const reasons = await runCase(caseRow);
        if (reasons.length) {
            console.error(`FAIL: ${caseRow.message}`);
            for (const r of reasons) console.error(`  - ${r}`);
        } else {
            passed += 1;
        }
    }
    console.log(`${passed}/${cases.length} elder facts cases passed`);
    return passed === cases.length ? 0 : 1;
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
