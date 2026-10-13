/**
 * Kavach's approved WhatsApp Utility templates (founder OK 2026-10-12), for a person whose 24-hour window is closed.
 *
 *   reminder  kavach_care_reminder        {{1}} what, {{2}} time; quick reply "Done" (payload done:<schedule> for a dose)
 *   summary   kavach_daily_summary        {{1}} the person cared for; the tap opens the chat and Saheli sends the brief
 *   alert_*   kavach_alert_<kind>_<lang>  {{1}} who it is about: a medicine not marked taken, no reply to a check-in, a
 *                                         health problem reported, an order waiting for approval; Saheli gives the
 *                                         alert itself when they tap
 *
 * Meta files each template name under one category for all its languages; a language it filed as MARKETING was taken
 * off the shared name and has its own (<base>_<lang>). So a template is looked up as <base>_<lang>, then <base>, in the
 * reader's language, then Hindi, then English, and only APPROVED + UTILITY ones are used (read from Meta, cached).
 * The texts live in Agents/…/scripts/meta_templates.py.
 */
import config from "../config/app.config";

export type TemplatePurpose =
    | "reminder"
    | "summary"
    | "alert_dose"
    | "alert_noreply"
    | "alert_health"
    | "alert_approval"
    | "alert"
    | "order"
    /** The general opener (B3.3): for everything without its own template; {{1}} = the reader's name, button "open:waiting". */
    | "message";

/** Template names per purpose, in order: a reworded alternate is tried where Meta did not file the first as UTILITY. */
export const TEMPLATE_BASES: Record<TemplatePurpose, string[]> = {
    reminder: ["kavach_care_reminder"],
    summary: ["kavach_daily_summary"],
    // a caregiver alert as a fixed sentence per kind, {{1}} = the person (kavach_alert_<kind>_<lang>)
    alert_dose: ["kavach_alert_dose"],
    alert_noreply: ["kavach_alert_noreply", "kavach_alert_wellbeing"],
    alert_health: ["kavach_alert_health", "kavach_alert_unwell"],
    alert_approval: ["kavach_alert_approval"],
    // free-text alert and order update ({{2}} = a line of the message): Meta filed both MARKETING (2026-10-12), so none
    // is approved and these go as before; kept for the engine's hints
    alert: ["kavach_alert"],
    order: ["kavach_order_update"],
    // the general opener; the account-update rewording where Meta filed the first MARKETING (2026-10-14: all 11 were)
    message: ["kavach_saheli_message", "kavach_saheli_update", "kavach_saheli_care"],
};

/** Params each template takes (Meta refuses a send with the wrong count). */
export const TEMPLATE_PARAMS: Record<TemplatePurpose, number> = {
    reminder: 2, summary: 1, alert_dose: 1, alert_noreply: 1, alert_health: 1, alert_approval: 1, alert: 2, order: 2, message: 1,
};

/** The fixed alert template for a caregiver alert's kind (backend notifyCaregivers kinds); none for the rest. */
export function alertTemplateFor(kind?: string): TemplatePurpose | null {
    switch (kind) {
        case "health_red_flag":
        case "emergency":
        case "crisis":
        case "symptom":
            return "alert_health";
        case "nudge_silence":
            return "alert_noreply";
        case "missed_tasks":
            return "alert_dose";
        default:
            return null;
    }
}

/** Languages Meta offers no templates in read the nearest one (Odia, Nepali and Konkani readers get Hindi). */
const NEAREST: Record<string, string> = { as: "bn", or: "hi", ne: "hi", kok: "hi" };

const CATALOG_MS = 30 * 60_000;
let catalog: { at: number; ok: Set<string> } | null = null;
let loading: Promise<Set<string>> | null = null;

async function fetchCatalog(): Promise<Set<string>> {
    const meta = config.whatsapp.meta;
    const ok = new Set<string>();
    if (!meta.wabaId || !meta.accessToken) return ok;
    let url: string | null = `https://graph.facebook.com/${meta.graphVersion || "v22.0"}/${meta.wabaId}/message_templates?fields=name,language,status,category&limit=200`;
    while (url) {
        const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${meta.accessToken}` } });
        if (!res.ok) throw new Error(`template list ${res.status}`);
        const body = (await res.json()) as { data?: Array<{ name: string; language: string; status: string; category: string }>; paging?: { next?: string } };
        for (const t of body.data ?? []) {
            if (t.name.startsWith("kavach_") && t.status === "APPROVED" && t.category === "UTILITY") ok.add(`${t.name}|${t.language}`);
        }
        url = body.paging?.next ?? null;
    }
    return ok;
}

/** Approved Utility templates ("name|lang"), cached for 30 minutes; the last good list is kept when Meta is down. */
export async function approvedTemplates(force = false): Promise<Set<string>> {
    if (!force && catalog && Date.now() - catalog.at < CATALOG_MS) return catalog.ok;
    loading ??= fetchCatalog()
        .then((ok) => {
            catalog = { at: Date.now(), ok };
            return ok;
        })
        .catch((err) => {
            console.warn("WhatsApp template list failed:", err instanceof Error ? err.message : err);
            return catalog?.ok ?? new Set<string>();
        })
        .finally(() => {
            loading = null;
        });
    return loading;
}

/** For tests. */
export function setTemplateCatalogForTest(ok: string[] | null): void {
    catalog = ok ? { at: Date.now(), ok: new Set(ok) } : null;
}

export function languageChain(lang?: string | null): string[] {
    const l = NEAREST[String(lang || "")] ?? (String(lang || "").toLowerCase() || "en");
    return [...new Set(l === "en" ? ["en", "hi"] : [l, "hi", "en"])];
}

/** The template to send for this purpose to someone who reads `lang`, or null when none is approved yet. */
export async function pickTemplate(purpose: TemplatePurpose, lang?: string | null): Promise<{ name: string; language: string } | null> {
    const ok = await approvedTemplates();
    for (const l of languageChain(lang)) {
        for (const base of TEMPLATE_BASES[purpose]) {
            for (const name of [`${base}_${l}`, base]) {
                if (ok.has(`${name}|${l}`)) return { name, language: l };
            }
        }
    }
    return null;
}

/** A template parameter: one line (Meta refuses newlines, tabs and long runs of spaces), short, never empty. */
export function templateParam(text: string, max = 120): string {
    const one = String(text ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
    if (!one) return "-";
    return one.length <= max ? one : `${one.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

/** The first sentence of a message, as the short line of an alert or update template. */
export function headlineOf(text: string, max = 90): string {
    const one = String(text ?? "").replace(/[*_~`]/g, "").replace(/\s+/g, " ").trim();
    const first = one.split(/(?<=[.!?।॥])\s/)[0] || one;
    return templateParam(first.replace(/[.।]$/, ""), max);
}

/** "08:30" / "20:30" → "8:30 AM" / "8:30 PM" (a reminder template's time). */
export function clockTime(hhmm: string): string {
    const m = String(hhmm ?? "").match(/^(\d{1,2}):(\d{2})/);
    if (!m) return templateParam(hhmm || "now", 20);
    const h = Number(m[1]);
    return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}
