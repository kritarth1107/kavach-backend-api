/**
 * Lightweight regression checks for WhatsApp Saheli smart replies and formatting.
 * Run: npx tsx scripts/test-whatsapp-saheli.ts
 */
import {
    formatScheduleSection,
    formatSaheliContextForAi,
    type SaheliContextBundle,
} from "../src/services/saheliContext.service";
import { formatOrderFlowForWhatsApp } from "../src/services/whatsappOrderFlow.service";
import type { OrderFlowPayload } from "../src/services/orderOrchestrator.service";
import {
    buildOrderFlowMessages,
    buildGuestWelcomeMessages,
    composeWhatsAppReply,
} from "../src/services/whatsappMessageComposer.service";

function assert(condition: boolean, message: string) {
    if (!condition) {
        console.error("FAIL:", message);
        process.exitCode = 1;
    } else {
        console.log("OK:", message);
    }
}

const mockBundle: SaheliContextBundle = {
    dateKey: "2025-09-19",
    schedule: [],
    missed: [
        {
            scheduleId: "1",
            title: "Blood pressure",
            time: "8:00 AM",
            type: "VITALS",
            status: "missed",
        },
        {
            scheduleId: "2",
            title: "Morning check-in",
            time: "9:00 AM",
            type: "CHECK_IN",
            status: "missed",
        },
    ],
    upcoming: [
        {
            scheduleId: "3",
            title: "Folvite",
            time: "1:00 PM",
            dosage: "1 tab",
            type: "MEDICINE",
            status: "upcoming",
        },
    ],
    completed: [],
    due: [],
    adherencePercent: 0,
    lastHeardLine: "Hi Saheli",
    lastHeardAt: "2025-09-19T10:00:00.000Z",
    lastCheckInAt: null,
    careRecordContext: "No Care Record events yet.",
    companionProfile: { enabled: true },
    connectedPartners: { swiggy: true, instamart: true, zepto: false },
    defaultAddressCount: 2,
    channel: "whatsapp",
};

const missedText = formatScheduleSection(mockBundle.missed, "Here's what you missed today");
assert(missedText.includes("8:00 AM"), "missed section includes BP time");
assert(missedText.includes("Blood pressure"), "missed section includes BP title");
assert(missedText.includes("Morning check-in"), "missed section includes check-in");

const aiContext = formatSaheliContextForAi(mockBundle);
assert(aiContext.includes("WhatsApp"), "AI context includes channel hint");
assert(aiContext.includes("Missed:"), "AI context includes missed block");

const orderFlow: OrderFlowPayload = {
    sessionId: "sess-1",
    phase: "select_address",
    partner: "instamart",
    partnerLabel: "Instamart",
    query: "1L milk",
    addresses: [
        { id: "a1", label: "Home", line1: "12 MG Road", city: "Bangalore", pincode: "560001" },
        { id: "a2", label: "Office", line1: "Tech Park", city: "Bangalore", pincode: "560100" },
    ],
    message: "Let's order from Instamart.",
};
const waOrder = formatOrderFlowForWhatsApp(orderFlow);
assert(waOrder.includes("1. Home"), "WhatsApp order flow lists address 1");
assert(waOrder.includes("cancel"), "WhatsApp order flow mentions cancel");

const richOrder = buildOrderFlowMessages(orderFlow);
assert(richOrder.some((m) => m.type === "interactive"), "order flow includes interactive list");

const guest = buildGuestWelcomeMessages(true);
assert(
    guest.some((m) => m.type === "interactive" || m.type === "image"),
    "guest welcome includes interactive or media",
);

const scheduleReply = composeWhatsAppReply("Here's what you missed today:\n• 8:00 AM — BP", {
    kind: "schedule_missed",
});
assert(
    scheduleReply.some((m) => m.type === "interactive"),
    "schedule reply includes quick-action buttons",
);

console.log(process.exitCode === 1 ? "\nSome checks failed." : "\nAll WhatsApp Saheli checks passed.");
