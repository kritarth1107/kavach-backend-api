/**
 * In-chat Ola booking:
 *   route → ride types (+ fares when signed in) → literal "confirm" → Ola sign-in code (only
 *   claimed once the page shows it was sent) → one-shot code → confirm screen → SECOND literal
 *   "confirm" with the exact vehicle, fare and cash → Confirm & Book → durable driver watch.
 * Driver watch (OlaRide in Mongo, ticks every 20 s, survives restarts): short non-repeating updates,
 * driver details + family message on assignment, Ola's own cancel pressed and verified on timeout /
 * no driver / user cancel, honest fallbacks (Ola / Uber / Rapido links) on any failure.
 */
import { randomUUID } from "crypto";
import WhatsappSession from "../../../models/whatsappSession.model";
import OlaRide, { type IOlaRide, type OlaRideStatus } from "../../../models/olaRide.model";
import { FamilyRole } from "../../../types/family.types";
import type { RideDraft, RidePlace } from "../types";
import { isLiteralConfirm, isSoftYes } from "../../commerceAutomation/literalConfirm";
import { isTestPhone } from "../../smokeFixtures.service";
import { loadRideConfig } from "../rideConfig";
import { geocodePlace } from "../geoResolve.service";
import { olaLink, rapidoLink, serviceChain, uberLink, type CityTier, type RideConfig, type Vehicle } from "../rideServices";
import { geocodeCandidates, OlaMsg, pinTipFor, type OlaFailReason, orderRideTypes, pickRideType, type OlaConfirmInfo, type OlaDriverInfo } from "./olaCopy";
import { type CashResult, FakeOlaDriver, PlaywrightOlaDriver, type OlaDriver } from "./olaDriver";
import { bookGate, type OlaGoal, type RecoveryLogEntry, type RecoveryOutcome } from "./olaRecovery";

export type OlaTurnInput = {
    phone: string;
    familyId: string;
    actorUserId: string;
    recipientUserId: string;
    actorRole: FamilyRole | null;
};

const log = (evt: string, data: Record<string, unknown>) => console.log(JSON.stringify({ evt, ...data }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Live pages + test scenarios ─────────────────────────────────────────────────────────────
const drivers = new Map<string, { driver: OlaDriver; at: number }>();
const scenarios = new Map<string, { scenario: string; timeScale: number }>();
const busy = new Set<string>();

// ── Page changed: goal-driven recovery ──────────────────────────────────────────────────────
/**
 * When a fixed step doesn't find what it expects, look at the screen and step toward the goal
 * (bounded; every decision logged as "ola_recover_step" + one dashboard diag entry). Safety gates
 * stay in code: recovery never books, pays, changes payment, sends a code or solves a robot check.
 */
async function recoverPage(input: OlaTurnInput, drv: OlaDriver, goal: OlaGoal, rideType: string): Promise<RecoveryOutcome | null> {
    if (!drv.recover) return null;
    const steps: RecoveryLogEntry[] = [];
    const out = await drv
        .recover(goal, rideType, (e) => {
            steps.push(e);
            log("ola_recover_step", { phone: input.phone.slice(-4), ...e });
        })
        .catch((): RecoveryOutcome => ({ ok: false, why: "error", steps: 0 }));
    log("ola_recover", { phone: input.phone.slice(-4), goal, rideType, ...out });
    const { logActivity } = await import("../../activityLog.service");
    void logActivity({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        kind: "diag",
        severity: out.ok ? "info" : "warn",
        title: `Ola page check: ${goal} → ${out.ok ? `found ${out.screen}` : out.why}`,
        detail: steps.map((e) => `${e.step}. ${e.screen} (${e.source}) → ${e.action.type}${e.action.target ? ` "${e.action.target}"` : ""}${e.allowed ? "" : ` refused:${e.refused}`}`).join("\n").slice(0, 1500),
        data: { stage: `ola_recover_${goal}`, steps },
    } as never).catch(() => undefined);
    return out;
}

type ChooseResult = "login" | "confirm" | "failed" | "blocked" | "live_ride";
/** Pick the ride type; if the page doesn't react as expected, recover toward sign-in / fare screen. */
async function chooseSmart(input: OlaTurnInput, drv: OlaDriver, type: string): Promise<ChooseResult> {
    const r = await drv.choose(type).catch(() => "failed" as const);
    if (r !== "failed") return r;
    const out = await recoverPage(input, drv, "chosen", type);
    if (!out) return "failed";
    if (out.ok) return out.screen === "confirm" ? "confirm" : "login";
    if (out.why === "captcha") return "blocked";
    if (out.why === "live_ride") return "live_ride";
    return "failed";
}
const chooseFail = (r: ChooseResult, fallback: string) => (r === "blocked" ? "robot_check" : r === "live_ride" ? "active_ride" : fallback);

/** Test numbers only (mock webhook): script Ola's page states and speed the clock up. */
export function setOlaTestScenario(phone: string, scenario: string, timeScale = 1): boolean {
    if (!isTestPhone(phone)) return false;
    scenarios.set(phone.replace(/\D/g, ""), { scenario, timeScale: Math.min(Math.max(timeScale, 1), 60) });
    return true;
}

async function driverFor(input: OlaTurnInput, fresh = false): Promise<OlaDriver> {
    const have = drivers.get(input.phone);
    if (have && !fresh) {
        have.at = Date.now();
        return have.driver;
    }
    if (have) await have.driver.close().catch(() => undefined);
    let d: OlaDriver;
    if (isTestPhone(input.phone)) {
        const s = scenarios.get(input.phone.replace(/\D/g, "")) || { scenario: "assigned", timeScale: 1 };
        d = new FakeOlaDriver(s.scenario, s.timeScale);
    } else {
        const { getOrCreateBrowserProfile } = await import("../../commerceAutomation/browserProfile.service");
        const prof = await getOrCreateBrowserProfile(input.familyId, input.actorUserId).catch(() => null);
        d = new PlaywrightOlaDriver(prof?.storageStateJson ?? null);
    }
    drivers.set(input.phone, { driver: d, at: Date.now() });
    return d;
}

async function dropDriver(phone: string): Promise<void> {
    const have = drivers.get(phone);
    drivers.delete(phone);
    await have?.driver.close().catch(() => undefined);
}

/** Close the parked page when a newer ask drops the Ola draft. */
export async function releaseOlaPage(phone: string): Promise<void> {
    const active = await OlaRide.exists({ phone, status: { $in: ["searching", "assigned", "cancelling"] } }).catch(() => null);
    if (!active) await dropDriver(phone);
}

// ── Draft helpers ───────────────────────────────────────────────────────────────────────────
async function loadDraft(phone: string): Promise<RideDraft | null> {
    const row = (await WhatsappSession.findOne({ phone }, { rideDraft: 1 }).lean().catch(() => null)) as { rideDraft?: RideDraft } | null;
    return row?.rideDraft || null;
}
async function saveDraft(phone: string, draft: RideDraft | null): Promise<void> {
    if (!draft) {
        await WhatsappSession.updateOne({ phone }, { $unset: { rideDraft: 1 }, $set: { updatedAt: new Date() } }).catch(() => undefined);
        return;
    }
    await WhatsappSession.updateOne({ phone }, { $set: { rideDraft: { ...draft, savedAt: new Date() }, updatedAt: new Date() } }, { upsert: true }).catch(() => undefined);
}
/** Still the same Ola conversation (not cancelled / superseded meanwhile)? */
async function current(phone: string, token: string, phases?: string[]): Promise<RideDraft | null> {
    const d = await loadDraft(phone);
    if (!d?.ola || d.ola.token !== token) return null;
    if (phases && !phases.includes(d.phase)) return null;
    return d;
}

async function send(input: Pick<OlaTurnInput, "phone" | "familyId" | "recipientUserId">, text: string): Promise<void> {
    const { pushWhatsAppBrowserFollowUp } = await import("../../commerceAutomation/browserProgressNotify.service");
    await pushWhatsAppBrowserFollowUp({ phone: input.phone, familyId: input.familyId, recipientUserId: input.recipientUserId, text }).catch(() => false);
}

function e164(phone: string): string {
    const d = phone.replace(/\D/g, "");
    return `+${d}`;
}
function phone10(phone: string): string | null {
    const d = phone.replace(/\D/g, "");
    return /^91\d{10}$/.test(d) ? d.slice(2) : null;
}

function fallbackText(lang: string | null | undefined, p?: RidePlace, d?: RidePlace, reason: OlaFailReason = "generic"): string {
    return OlaMsg.failed(lang, olaLink(p, d), uberLink(p, d), rapidoLink(p, d), reason);
}

/** Run background work after the reply has gone out (acks always arrive first). */
function later(fn: () => Promise<void>, what: string): void {
    void (async () => {
        await sleep(1500);
        await fn();
    })().catch((err) => log("ola_bg_failed", { what, error: err instanceof Error ? err.message.slice(0, 160) : String(err) }));
}

// ── Entry: route confirmed and Ola is the best in-chat option ───────────────────────────────
export function olaInChatEligible(input: { phone: string; cfg: RideConfig; tier: CityTier; vehicle: Vehicle; olaStatus: string; requested?: string | null }): boolean {
    const { cfg } = input;
    if (!cfg.olaInChat || cfg.disabled.includes("ola")) return false;
    if (input.requested && input.requested !== "ola") return false;
    if (input.olaStatus === "no") return false;
    if (!serviceChain(input.tier, input.vehicle, cfg).includes("ola")) return false;
    return isTestPhone(input.phone) || Boolean(phone10(input.phone));
}

export async function startOlaInChat(input: OlaTurnInput, draft: RideDraft, lang: string | null): Promise<{ text: string; draft: RideDraft }> {
    const token = randomUUID();
    const d: RideDraft = { ...draft, provider: "ola", phase: "ola_loading", ola: { token, lang, phoneE164: e164(input.phone) } };
    await saveDraft(input.phone, d);
    log("ola_start", { phone: input.phone.slice(-4), vehicle: draft.vehicle || "cab" });
    later(async () => {
        // Ola needs map points for both ends; a saved address without them is looked up first.
        for (const k of ["pickup", "drop"] as const) {
            const pl = draft[k];
            if (pl && (pl.lat == null || pl.lng == null)) {
                // Full address first, then without the flat/house part, then the short name.
                const tries = geocodeCandidates((pl.address || pl.raw || "").trim(), pl.shortLabel || "");
                let hit = false;
                for (const [i, q] of tries.entries()) {
                    if (i) await sleep(1100); // public lookup service: max one request a second
                    const g = await geocodePlace(q).catch(() => null);
                    if (g?.ok && g.place.lat != null && g.place.lng != null) {
                        draft[k] = { ...pl, lat: g.place.lat, lng: g.place.lng };
                        hit = true;
                        break;
                    }
                }
                if (!hit) log("ola_no_point", { end: k, phone: input.phone.slice(-4) });
            }
        }
        const url = olaLink(draft.pickup, draft.drop);
        let types: Awaited<ReturnType<OlaDriver["rideTypes"]>> = [];
        if (url) try {
            const drv = await driverFor(input, true);
            await drv.open(url);
            types = orderRideTypes(await drv.rideTypes(), draft.vehicle || "cab");
            if (!types.length) {
                const out = await recoverPage(input, drv, "ride_list", draft.vehicle === "auto" ? "Auto" : "Mini");
                if (out?.ok) types = orderRideTypes(await drv.rideTypes(), draft.vehicle || "cab");
            }
        } catch (err) {
            log("ola_types_failed", { error: err instanceof Error ? err.message.slice(0, 160) : String(err) });
        }
        const cur = await current(input.phone, token, ["ola_loading"]);
        if (!cur) return;
        if (!types.length) {
            log("ola_types_empty", { phone: input.phone.slice(-4), hadUrl: Boolean(url) });
            await saveDraft(input.phone, null);
            await dropDriver(input.phone);
            const pickupHasPoint = draft.pickup?.lat != null && draft.pickup?.lng != null;
            // Never ask for a location she already shared.
            const pinTip = pinTipFor(lang, Boolean(url), draft.pickup);
            await send(input, fallbackText(lang, draft.pickup, draft.drop, url ? "no_rides" : pickupHasPoint ? "no_drop_point" : "no_map_point") + pinTip);
            return;
        }
        cur.phase = "ola_pick_type";
        cur.pickup = draft.pickup;
        cur.drop = draft.drop;
        cur.ola = { ...cur.ola!, types };
        await saveDraft(input.phone, cur);
        const dropName = draft.drop?.shortLabel || draft.drop?.address?.split(",")[0] || (lang && /^hi/i.test(lang) ? "aapki jagah" : "your drop");
        await send(input, OlaMsg.types(lang, dropName, types, url));
    }, "types");
    return { text: OlaMsg.checking(lang), draft: d };
}

// ── Turns while an Ola draft is open ────────────────────────────────────────────────────────
const CANCEL_RE = /^(cancel|stop|rok(o|na)?|ruk(o|na)?|band karo|cancel karo|mat karo|never\s*mind|nahi chahiye)\b/i;
const YES_RE = /^(yes|haan|ha|han|ji|ok|okay|theek hai|sure|y)\b/i;
const NO_RE = /^(no|nahi|nahin|na|mat|rehne do)\b/i;

export function isOlaPhase(phase?: string): boolean {
    return Boolean(phase && phase.startsWith("ola_"));
}

/** While a ride is live, only ride talk belongs to it; "khana kha liya" / a BP reading goes to the normal chat. */
const RIDE_TALK_RE = /\b(driver|cab|taxi|gaa?di|gadi|car|auto|bike|ola|ride|otp|plate|kahan|kidhar|kitni der|how long|eta|arriv\w*|pahunch\w*|aa raha|aa rahi|status|booking|booked|search|dhoondh\w*)\b/i;
export function isOlaLiveRideTalk(text: string): boolean {
    return CANCEL_RE.test(text.trim()) || RIDE_TALK_RE.test(text.trim());
}

export async function handleOlaTurn(input: OlaTurnInput, draft: RideDraft, text: string): Promise<{ text: string; draft?: RideDraft | null } | null> {
    const t = text.trim();
    const lang = draft.ola?.lang ?? null;
    const token = draft.ola?.token || "";
    const hi = /^hi/i.test(String(lang || ""));

    // Booked: search running / driver on the way.
    if ((draft.phase === "ola_searching" || draft.phase === "ola_booking" || draft.phase === "ola_assigned") && !isOlaLiveRideTalk(t)) return null;
    if (draft.phase === "ola_searching" || draft.phase === "ola_booking") {
        if (CANCEL_RE.test(t)) return await userCancel(input, draft);
        return { text: OlaMsg.stillSearching(lang) };
    }
    if (draft.phase === "ola_assigned") {
        const ride = draft.ola?.rideId ? await OlaRide.findOne({ rideId: draft.ola.rideId }).lean() : null;
        if (CANCEL_RE.test(t)) {
            draft.phase = "ola_cancel_assigned_ask";
            await saveDraft(input.phone, draft);
            return { text: OlaMsg.cancelAssignedAsk(lang) };
        }
        return { text: OlaMsg.rideOn(lang, (ride?.driver as OlaDriverInfo) || {}) };
    }
    if (draft.phase === "ola_cancel_assigned_ask") {
        if (YES_RE.test(t) || CANCEL_RE.test(t)) return await userCancel(input, draft);
        draft.phase = "ola_assigned";
        await saveDraft(input.phone, draft);
        return { text: OlaMsg.cancelKeep(lang) };
    }

    // Before booking: cancel drops everything (nothing booked).
    if (CANCEL_RE.test(t)) {
        await saveDraft(input.phone, null);
        await dropDriver(input.phone);
        return { text: hi ? "Theek hai, Ola wala rok diya 🙏 Kuch book nahi hua." : "Okay, stopped the Ola booking 🙏 Nothing was booked.", draft: null };
    }
    if (/\b(link|uber|rapido)\b/i.test(t) && draft.phase !== "ola_awaiting_otp") {
        await saveDraft(input.phone, null);
        await dropDriver(input.phone);
        return { text: OlaMsg.links(lang, uberLink(draft.pickup, draft.drop), rapidoLink(draft.pickup, draft.drop)), draft: null };
    }

    switch (draft.phase) {
        case "ola_loading":
        case "ola_signing_in":
        case "ola_checking_otp":
            return { text: hi ? "Ola par kaam chal raha hai, bas ek pal 🙏" : "Working on it in Ola — one moment 🙏" };

        case "ola_pick_type": {
            const pick = pickRideType(t, draft.ola?.types || []);
            if (!pick) return { text: OlaMsg.types(lang, draft.drop?.shortLabel || "", draft.ola?.types || [], olaLink(draft.pickup, draft.drop)) };
            return await chooseType(input, draft, pick.name);
        }

        case "ola_confirm_signin": {
            const pick = pickRideType(t, draft.ola?.types || []);
            if (pick && !isLiteralConfirm(t)) return await chooseType(input, draft, pick.name);
            if (!isLiteralConfirm(t)) return { text: isSoftYes(t) || YES_RE.test(t) ? OlaMsg.softYesSignIn(lang) : OlaMsg.confirmSignIn(lang, draft.ola!.chosen!, draft.ola!.phoneE164 || e164(input.phone)) };
            draft.phase = "ola_signing_in";
            await saveDraft(input.phone, draft);
            later(() => signIn(input, token), "signin");
            return { text: OlaMsg.openingSignIn(lang) };
        }

        case "ola_awaiting_otp": {
            const code = t.replace(/\D/g, "");
            if (!/^\d{4}$/.test(code)) return { text: OlaMsg.otpNeedDigits(lang) };
            // One-shot: the code is used once; a duplicate message can't submit it again.
            draft.phase = "ola_checking_otp";
            await saveDraft(input.phone, draft);
            later(() => submitCode(input, token, code), "otp");
            return { text: OlaMsg.otpChecking(lang) };
        }

        case "ola_confirm_book": {
            if (!isLiteralConfirm(t)) {
                const pick = pickRideType(t, draft.ola?.types || []);
                if (pick && pick.name !== draft.ola?.chosen) return await chooseType(input, draft, pick.name);
                return { text: isSoftYes(t) || YES_RE.test(t) ? OlaMsg.softYesBook(lang) : OlaMsg.confirmBook(lang, draft.ola!.confirm!) };
            }
            draft.phase = "ola_booking";
            await saveDraft(input.phone, draft);
            later(() => book(input, token), "book");
            return { text: OlaMsg.booking(lang) };
        }

        case "ola_offer": {
            if (/^(1|phir|fir|again|retry|search again|dobara|haan|yes|ha)\b/i.test(t) && draft.ola?.chosen) return await chooseType(input, draft, draft.ola.chosen, true);
            if (/^3\b/.test(t)) {
                await saveDraft(input.phone, null);
                await dropDriver(input.phone);
                return { text: OlaMsg.links(lang, uberLink(draft.pickup, draft.drop), rapidoLink(draft.pickup, draft.drop)), draft: null };
            }
            const pick = pickRideType(t.replace(/^2\b/, "").trim(), draft.ola?.types || []);
            if (pick) return await chooseType(input, draft, pick.name, true);
            if (/^(2|doosri|dusri|different|other|another)\b/i.test(t)) {
                draft.phase = "ola_pick_type";
                await saveDraft(input.phone, draft);
                return { text: OlaMsg.types(lang, draft.drop?.shortLabel || "", draft.ola?.types || [], olaLink(draft.pickup, draft.drop)) };
            }
            await saveDraft(input.phone, null);
            return { text: hi ? "Theek hai 🙏" : "Okay 🙏", draft: null };
        }
    }
    return { text: OlaMsg.stillSearching(lang) };
}

/** Ride type chosen: signed in → fetch the real fare; otherwise ask the literal confirm to sign in. */
async function chooseType(input: OlaTurnInput, draft: RideDraft, type: string, reopen = false): Promise<{ text: string; draft: RideDraft }> {
    const lang = draft.ola?.lang ?? null;
    draft.ola = { ...draft.ola!, chosen: type, confirm: undefined };
    const drv = await driverFor(input);
    if (reopen) {
        // After a finished search: reopen the route on Ola, then the same sign-in / fare steps.
        draft.phase = "ola_checking_otp";
        await saveDraft(input.phone, draft);
        const token = draft.ola.token;
        later(async () => {
            const url = olaLink(draft.pickup, draft.drop);
            if (url) await drv.open(url).catch(() => undefined);
            await drv.rideTypes().catch(() => []);
            if (!(await current(input.phone, token))) return;
            const r = await chooseSmart(input, drv, type);
            if (r === "confirm") return showConfirmCard(input, token, drv);
            if (r !== "login") return fail(input, token, chooseFail(r, "reopen_failed"));
            const cur = await current(input.phone, token);
            if (!cur) return;
            cur.phase = "ola_confirm_signin";
            await saveDraft(input.phone, cur);
            await send(input, OlaMsg.confirmSignIn(lang, type, cur.ola!.phoneE164 || e164(input.phone)));
        }, "reopen");
        return { text: OlaMsg.fetchingFare(lang), draft };
    }
    if (await drv.loggedIn().catch(() => false)) {
        draft.phase = "ola_checking_otp"; // "fetching the fare" step
        await saveDraft(input.phone, draft);
        const token = draft.ola.token;
        later(async () => {
            const r = await chooseSmart(input, drv, type);
            if (r === "confirm") await showConfirmCard(input, token, drv);
            else if (r === "login") {
                const cur = await current(input.phone, token);
                if (!cur) return;
                cur.phase = "ola_confirm_signin";
                await saveDraft(input.phone, cur);
                await send(input, OlaMsg.confirmSignIn(lang, type, cur.ola!.phoneE164 || e164(input.phone)));
            } else await fail(input, token, chooseFail(r, "choose_failed"));
        }, "choose");
        return { text: OlaMsg.fetchingFare(lang), draft };
    }
    draft.phase = "ola_confirm_signin";
    await saveDraft(input.phone, draft);
    return { text: OlaMsg.confirmSignIn(lang, type, draft.ola.phoneE164 || e164(input.phone)), draft };
}

/** Internal step → the reason the elder is told (one message, reason + links). */
function reasonFor(why: string): OlaFailReason {
    if (why === "not_cash" || why === "no_cash_option" || why === "no_fare" || why === "book_failed" || why === "code_wrong_3x" || why === "robot_check" || why === "active_ride") return why;
    if (why.startsWith("login_") || why === "otp_failed") return "sign_in_code";
    if (why === "otp_invalid_3x") return "code_wrong_3x";
    if (/reopen|choose|no_login_page|no_confirm/.test(why)) return "page_changed";
    return "generic";
}

async function fail(input: OlaTurnInput, token: string, why: string, detail?: Record<string, unknown>): Promise<void> {
    const cur = await current(input.phone, token);
    if (!cur) return;
    log("ola_failed", { why, ...(detail || {}) });
    // Keep what Ola's page showed (masked) so a live failure can be diagnosed from the dashboard.
    const d = drivers.get(input.phone)?.driver;
    if (d?.diagnose) await d.diagnose({ familyId: input.familyId, userId: input.actorUserId, recipientUserId: input.recipientUserId, stage: `ola_${why}`, reason: JSON.stringify(detail || {}).slice(0, 300) }).catch(() => undefined);
    await saveDraft(input.phone, null);
    await dropDriver(input.phone);
    await send(input, fallbackText(cur.ola?.lang, cur.pickup, cur.drop, reasonFor(why)));
}

async function signIn(input: OlaTurnInput, token: string): Promise<void> {
    const cur = await current(input.phone, token, ["ola_signing_in"]);
    if (!cur) return;
    const lang = cur.ola?.lang ?? null;
    const drv = await driverFor(input);
    const where = await chooseSmart(input, drv, cur.ola!.chosen!);
    if (where === "confirm") return showConfirmCard(input, token, drv);
    if (where !== "login") return fail(input, token, chooseFail(where, "no_login_page"));
    const p10 = phone10(input.phone) || (isTestPhone(input.phone) ? "9999999999" : null);
    if (!p10) return fail(input, token, "not_indian_number");
    const r = await drv.startLogin(p10).catch(() => "failed" as const);
    log("ola_login_start", { result: r });
    // Honest: "code sent" only when Ola's page says it sent one.
    if (r !== "otp_sent") return fail(input, token, `login_${r}`);
    const again = await current(input.phone, token, ["ola_signing_in"]);
    if (!again) return;
    again.phase = "ola_awaiting_otp";
    await saveDraft(input.phone, again);
    await send(input, OlaMsg.otpSent(lang, again.ola!.phoneE164 || e164(input.phone)));
}

async function submitCode(input: OlaTurnInput, token: string, code: string): Promise<void> {
    const cur = await current(input.phone, token, ["ola_checking_otp"]);
    if (!cur) return;
    const lang = cur.ola?.lang ?? null;
    const drv = await driverFor(input);
    const r = await drv.submitOtp(code).catch(() => "failed" as const);
    log("ola_otp", { result: r });
    if (r === "invalid") {
        const tries = (cur.ola!.otpTries || 0) + 1;
        if (tries >= 3) return fail(input, token, "otp_invalid_3x");
        cur.ola = { ...cur.ola!, otpTries: tries };
        cur.phase = "ola_awaiting_otp";
        await saveDraft(input.phone, cur);
        await send(input, OlaMsg.otpWrong(lang));
        return;
    }
    if (r === "failed") return fail(input, token, "otp_failed");
    // Signed in: keep the sign-in for this person (encrypted) so the next ride / a restart needs no code.
    if (drv.kind === "real") {
        const st = await drv.storageState();
        if (st) {
            const { saveBrowserProfileState } = await import("../../commerceAutomation/browserProfile.service");
            await saveBrowserProfileState({ familyId: input.familyId, userId: input.actorUserId, storageStateJson: st, lastPartner: "ola" }).catch(() => undefined);
        }
    }
    if (r === "list") {
        const w = await chooseSmart(input, drv, cur.ola!.chosen!);
        if (w !== "confirm") return fail(input, token, chooseFail(w, "no_confirm_after_login"));
    }
    await showConfirmCard(input, token, drv);
}

async function readConfirmSmart(input: OlaTurnInput, drv: OlaDriver, type: string): Promise<OlaConfirmInfo | null> {
    const info = await drv.readConfirm(type).catch(() => null);
    if (info?.fare) return info;
    const out = await recoverPage(input, drv, "confirm", type);
    return out?.ok ? await drv.readConfirm(type).catch(() => null) : null;
}

async function showConfirmCard(input: OlaTurnInput, token: string, drv: OlaDriver): Promise<void> {
    const cur = await current(input.phone, token);
    if (!cur) return;
    const lang = cur.ola?.lang ?? null;
    const info = await readConfirmSmart(input, drv, cur.ola!.chosen!);
    if (!info?.fare) return fail(input, token, "no_fare");
    // Never a different ride type than she picked.
    if (info.vehicle && info.vehicle.toLowerCase() !== cur.ola!.chosen!.toLowerCase()) return fail(input, token, "no_fare", { shownVehicle: info.vehicle });
    // Cash only: select it on Ola's payment picker and read it back; never book otherwise.
    const cash: CashResult = await drv.ensureCash().catch((): CashResult => ({ ok: false, reason: "select_failed" }));
    log("ola_cash", { ok: cash.ok, reason: cash.ok ? undefined : cash.reason, selected: cash.selected, options: cash.options });
    if (!cash.ok) return fail(input, token, cash.reason === "no_cash_option" ? "no_cash_option" : "not_cash", { selected: cash.selected, options: cash.options });
    const again = await current(input.phone, token);
    if (!again) return;
    again.phase = "ola_confirm_book";
    again.ola = { ...again.ola!, confirm: { ...info, pay: "Cash" } };
    await saveDraft(input.phone, again);
    await send(input, OlaMsg.confirmBook(lang, again.ola.confirm!));
}

async function book(input: OlaTurnInput, token: string): Promise<void> {
    const cur = await current(input.phone, token, ["ola_booking"]);
    if (!cur) return;
    const lang = cur.ola?.lang ?? null;
    const drv = await driverFor(input);
    // HARD gate (code, not the model): the page must still show the ride, fare and pickup she
    // confirmed, with Cash read back from Ola's picker. Anything changed → ask her again.
    const shown = cur.ola?.confirm;
    const page = await readConfirmSmart(input, drv, cur.ola!.chosen!);
    const cashNow: CashResult = page ? await drv.ensureCash().catch((): CashResult => ({ ok: false, reason: "select_failed" })) : { ok: false, reason: "no_selector" };
    const gate = bookGate(shown ? { ...shown, vehicle: shown.vehicle || cur.ola!.chosen! } : undefined, page ? { ...page, vehicle: page.vehicle || "" } : null, cashNow.ok);
    log("ola_book_gate", { ok: gate.ok, why: gate.ok ? undefined : gate.why, shownFare: shown?.fare, pageFare: page?.fare, cash: cashNow.ok });
    if (!gate.ok) {
        if (gate.reask) {
            const again = await current(input.phone, token, ["ola_booking"]);
            if (!again) return;
            again.phase = "ola_confirm_book";
            again.ola = { ...again.ola!, confirm: { ...page!, vehicle: page!.vehicle || again.ola!.chosen!, pay: "Cash" } };
            await saveDraft(input.phone, again);
            await send(input, OlaMsg.confirmChanged(lang, gate.why, again.ola.confirm!));
            return;
        }
        return fail(input, token, gate.why === "not_cash" ? "not_cash" : "no_fare", { at: "book_gate", why: gate.why });
    }
    const r = await drv.book().catch(() => "failed" as const);
    log("ola_book", { result: r });
    if (r === "not_cash") return fail(input, token, "not_cash", { at: "book" });
    if (r === "failed") return fail(input, token, "book_failed");
    const rideId = randomUUID();
    const sc = drv.kind === "fake" ? scenarios.get(input.phone.replace(/\D/g, "")) || { scenario: "assigned", timeScale: 1 } : null;
    const c = cur.ola!.confirm!;
    const doc = await OlaRide.create({
        rideId,
        phone: input.phone,
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        lang,
        status: "searching",
        vehicle: c.vehicle,
        fare: page?.fare ?? c.fare,
        pickupLabel: c.pickup,
        dropLabel: c.drop,
        pickup: cur.pickup as Record<string, unknown>,
        drop: cur.drop as Record<string, unknown>,
        bookedAt: new Date(),
        lastUpdateAt: new Date(),
        updateIdx: 0,
        cancelAttempts: 0,
        ...(sc ? { fake: sc } : {}),
    });
    if (drv instanceof FakeOlaDriver) drv.bind(doc);
    cur.phase = "ola_searching";
    cur.ola = { ...cur.ola!, rideId };
    await saveDraft(input.phone, cur);
    await send(input, r === "unknown" ? OlaMsg.bookUnverified(lang) : OlaMsg.searching(lang));
    const { logActivity } = await import("../../activityLog.service");
    void logActivity({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        kind: "ride",
        title: `Ola ${c.vehicle} requested — finding a driver`,
        detail: `${c.pickup || ""} → ${c.drop || ""} · ₹${c.fare ?? "?"} · Cash`,
        data: { provider: "ola", rideId, vehicle: c.vehicle, fare: c.fare, status: "searching" },
    }).catch(() => undefined);
    if (r === "assigned") void tickRide(rideId);
}

async function userCancel(input: OlaTurnInput, draft: RideDraft): Promise<{ text: string; draft: RideDraft }> {
    const lang = draft.ola?.lang ?? null;
    const rideId = draft.ola?.rideId;
    if (rideId) {
        await OlaRide.updateOne({ rideId, status: { $in: ["searching", "assigned"] } }, { $set: { status: "cancelling", cancelReason: "user" } });
        void tickRide(rideId);
    }
    return { text: OlaMsg.cancelling(lang), draft };
}

// ── Durable driver watch ────────────────────────────────────────────────────────────────────
const reattachFails = new Map<string, number>();

async function attach(doc: IOlaRide): Promise<OlaDriver | null> {
    const have = drivers.get(doc.phone);
    if (have) {
        if (have.driver instanceof FakeOlaDriver) have.driver.bind(doc);
        return have.driver;
    }
    // Restart: reopen the ride on Ola with the saved sign-in.
    if (doc.fake) {
        const d = new FakeOlaDriver(doc.fake.scenario, doc.fake.timeScale, doc);
        drivers.set(doc.phone, { driver: d, at: Date.now() });
        return d;
    }
    const d = await driverFor({ phone: doc.phone, familyId: doc.familyId, actorUserId: doc.actorUserId, recipientUserId: doc.recipientUserId, actorRole: null }, true);
    if (await d.reattach()) {
        reattachFails.delete(doc.rideId);
        log("ola_reattached", { rideId: doc.rideId });
        return d;
    }
    await dropDriver(doc.phone);
    const n = (reattachFails.get(doc.rideId) || 0) + 1;
    reattachFails.set(doc.rideId, n);
    return null;
}

async function setDraftPhase(phone: string, rideId: string, phase: RideDraft["phase"] | null): Promise<void> {
    const d = await loadDraft(phone);
    if (!d?.ola || d.ola.rideId !== rideId) return;
    if (phase === null) await saveDraft(phone, null);
    else await saveDraft(phone, { ...d, phase });
}

async function finish(doc: IOlaRide, status: OlaRideStatus, draftPhase: RideDraft["phase"] | null, msg: string | null, title: string): Promise<void> {
    await OlaRide.updateOne({ rideId: doc.rideId }, { $set: { status, endedAt: new Date() } });
    await setDraftPhase(doc.phone, doc.rideId, draftPhase);
    // The page stays open (signed in) for a quick "search again"; closed by the idle sweep.
    if (msg) await send(doc, msg);
    log("ola_ride_end", { rideId: doc.rideId, status });
    const { logActivity } = await import("../../activityLog.service");
    void logActivity({
        familyId: doc.familyId,
        recipientUserId: doc.recipientUserId,
        actorUserId: doc.actorUserId,
        kind: "ride",
        title,
        detail: `${doc.pickupLabel || ""} → ${doc.dropLabel || ""}`,
        data: { provider: "ola", rideId: doc.rideId, status },
    }).catch(() => undefined);
}

async function cancelOnOla(doc: IOlaRide, drv: OlaDriver, cfg: RideConfig): Promise<void> {
    const lang = doc.lang ?? null;
    const reason = doc.cancelReason || "user";
    let ok = await drv.cancel().catch(() => false);
    if (!ok) {
        // Verify on the page: no live search / ride left counts as cancelled.
        const s = await drv.status().catch(() => ({ state: "unknown" as const }));
        ok = s.state === "cancelled";
    }
    log("ola_cancel", { rideId: doc.rideId, reason, ok, attempt: doc.cancelAttempts + 1 });
    if (ok) {
        const minutes = Math.round(cfg.olaSearchTimeoutSec / 60);
        if (reason === "user") return finish(doc, "cancelled", null, OlaMsg.cancelledByUser(lang), "Ola ride cancelled");
        if (reason === "timeout") return finish(doc, "no_driver", "ola_offer", OlaMsg.noDriverTimeout(lang, minutes), `Ola: no driver in ${minutes} min — search cancelled`);
        return finish(doc, "no_driver", "ola_offer", OlaMsg.olaNoDriver(lang), "Ola: no driver available — search cancelled");
    }
    const attempts = doc.cancelAttempts + 1;
    const set: Record<string, unknown> = { cancelAttempts: attempts };
    if (attempts === 1) {
        const hi = /^hi/i.test(String(lang || ""));
        const why =
            reason === "timeout"
                ? hi ? `${Math.round(cfg.olaSearchTimeoutSec / 60)} minute mein driver nahi mila, isliye search band kar rahi hoon. ` : `No driver in ${Math.round(cfg.olaSearchTimeoutSec / 60)} minutes, so I'm stopping the search. `
                : reason === "no_driver"
                  ? hi ? "Ola ke paas abhi driver nahi hai, search band kar rahi hoon. " : "Ola has no drivers free, so I'm stopping the search. "
                  : "";
        await send(doc, why + OlaMsg.cancelRetrying(lang));
    }
    // ~15 min of retries every 20 s: stop hammering, leave it flagged for the family + dashboard.
    if (attempts >= 45) {
        await OlaRide.updateOne({ rideId: doc.rideId }, { $set: { status: "failed", endedAt: new Date(), cancelAttempts: attempts } });
        log("ola_cancel_gave_up", { rideId: doc.rideId });
        const hi = /^hi/i.test(String(lang || ""));
        const link = olaLink(doc.pickup as RidePlace, doc.drop as RidePlace) || "https://book.olacabs.com/";
        await setDraftPhase(doc.phone, doc.rideId, null);
        await send(doc, hi ? `Maaf kijiye 🙏 Main Ola par request band nahi kar paayi. Ola app mein kholkar ise cancel kar dijiye: ${link}` : `I'm sorry 🙏 I couldn't stop the request on Ola. Please open the Ola app and cancel it there: ${link}`);
        return;
    }
    if (attempts >= 3 && !doc.cancelNotifiedStuck) {
        set.cancelNotifiedStuck = true;
        await send(doc, OlaMsg.cancelStuck(lang, olaLink(doc.pickup as RidePlace, doc.drop as RidePlace) || "https://book.olacabs.com/"));
        const { notifyCaregivers } = await import("../../saheliCaregiverAlert.service");
        void notifyCaregivers({ familyId: doc.familyId, recipientUserId: doc.recipientUserId, actorUserId: doc.actorUserId, kind: "order_placed", urgency: "medium", message: "Saheli couldn't cancel an Ola ride request on Ola. Please check the Ola app and cancel it there if it's still open." }).catch(() => undefined);
    }
    await OlaRide.updateOne({ rideId: doc.rideId }, { $set: set });
}

/** One watch step for one ride. Serialized per ride; never throws. */
export async function tickRide(rideId: string): Promise<void> {
    if (busy.has(rideId)) return;
    busy.add(rideId);
    try {
        const doc = (await OlaRide.findOne({ rideId }).lean()) as IOlaRide | null;
        if (!doc || !["searching", "assigned", "cancelling"].includes(doc.status)) return;
        const cfg = await loadRideConfig();
        const scale = doc.fake?.timeScale || 1;
        const lang = doc.lang ?? null;
        const drv = await attach(doc);
        if (!drv) {
            if ((reattachFails.get(doc.rideId) || 0) >= 3) {
                reattachFails.delete(doc.rideId);
                const link = olaLink(doc.pickup as RidePlace, doc.drop as RidePlace) || "https://book.olacabs.com/";
                const hi = /^hi/i.test(String(lang || ""));
                await finish(doc, "ended", null, hi ? `Ola par aapki ride ka haal mujhe nahi dikh raha 🙏 Ola app mein dekh lijiye: ${link}` : `I can't see your ride on Ola any more 🙏 Please check the Ola app: ${link}`, "Ola ride — lost sight of it");
            }
            return;
        }
        if (drv instanceof FakeOlaDriver) drv.bind(doc);
        if (doc.status === "cancelling") return await cancelOnOla(doc, drv, cfg);

        const st = await drv.status().catch(() => ({ state: "unknown" as const, driver: undefined }));
        const now = Date.now();
        if (doc.status === "searching") {
            if (st.state === "assigned") return await onAssigned(doc, st.driver || {});
            if (st.state === "cancelled" || st.state === "driver_cancelled") return await finish(doc, "driver_cancelled", "ola_offer", OlaMsg.driverCancelled(lang), "Ola ride cancelled by Ola");
            const elapsed = ((now - new Date(doc.bookedAt).getTime()) / 1000) * scale;
            if (st.state === "no_driver" || elapsed >= cfg.olaSearchTimeoutSec) {
                const reason = st.state === "no_driver" ? "no_driver" : "timeout";
                await OlaRide.updateOne({ rideId, status: "searching" }, { $set: { status: "cancelling", cancelReason: reason } });
                return await cancelOnOla({ ...doc, status: "cancelling", cancelReason: reason }, drv, cfg);
            }
            const since = ((now - new Date(doc.lastUpdateAt || doc.bookedAt).getTime()) / 1000) * scale;
            if (since >= cfg.olaUpdateEverySec && elapsed + 30 < cfg.olaSearchTimeoutSec) {
                await OlaRide.updateOne({ rideId }, { $set: { lastUpdateAt: new Date(), updateIdx: doc.updateIdx + 1 } });
                await send(doc, OlaMsg.update(lang, doc.updateIdx));
            }
            return;
        }
        // assigned
        if (st.state === "driver_cancelled" || st.state === "cancelled") return await finish(doc, "driver_cancelled", "ola_offer", OlaMsg.driverCancelled(lang), "Ola driver cancelled");
        if (st.state === "started") return await finish(doc, "started", null, null, "Ola ride started");
        const since = ((now - new Date(doc.assignedAt || doc.bookedAt).getTime()) / 1000) * scale;
        if (since >= cfg.olaAssignedWatchMin * 60) return await finish(doc, "ended", null, null, "Ola ride — watch ended");
    } catch (err) {
        log("ola_tick_failed", { rideId, error: err instanceof Error ? err.message.slice(0, 160) : String(err) });
    } finally {
        busy.delete(rideId);
    }
}

async function onAssigned(doc: IOlaRide, driver: OlaDriverInfo): Promise<void> {
    const lang = doc.lang ?? null;
    await OlaRide.updateOne({ rideId: doc.rideId }, { $set: { status: "assigned", driver, assignedAt: new Date() } });
    await setDraftPhase(doc.phone, doc.rideId, "ola_assigned");
    await send(doc, OlaMsg.assigned(lang, driver, doc.fare));
    log("ola_assigned", { rideId: doc.rideId, hasPlate: Boolean(driver.plate), hasOtp: Boolean(driver.otp) });
    const info: OlaConfirmInfo = { vehicle: doc.vehicle, fare: doc.fare, pickup: doc.pickupLabel, drop: doc.dropLabel };
    const { getFamilyMembersList } = await import("../../familyMember.service");
    const elderName = await getFamilyMembersList(doc.familyId, doc.recipientUserId)
        .then((p) => p.members.find((m) => m.userId === doc.recipientUserId)?.name)
        .catch(() => undefined);
    const who = elderName?.trim() || "Your family member";
    const { logActivity } = await import("../../activityLog.service");
    void logActivity({
        familyId: doc.familyId,
        recipientUserId: doc.recipientUserId,
        actorUserId: doc.actorUserId,
        kind: "ride",
        title: `Ola ${doc.vehicle} booked — driver assigned`,
        detail: `${doc.pickupLabel || ""} → ${doc.dropLabel || ""} · ₹${doc.fare ?? "?"} · Cash · ${[driver.name, driver.plate].filter(Boolean).join(" · ")}`,
        data: { provider: "ola", rideId: doc.rideId, status: "assigned", driver: { name: driver.name, vehicle: driver.vehicle, plate: driver.plate, etaMin: driver.etaMin } },
    }).catch(() => undefined);
    // A placed ride counts as a placed order (one of the four family-message categories).
    const { notifyCaregivers, claimCaregiverAlert } = await import("../../saheliCaregiverAlert.service");
    if (claimCaregiverAlert(`ola:${doc.rideId}`, 6 * 3600_000)) {
        void notifyCaregivers({
            familyId: doc.familyId,
            recipientUserId: doc.recipientUserId,
            actorUserId: doc.actorUserId,
            kind: "order_placed",
            urgency: "low",
            message: OlaMsg.caregiverBooked(who, info, driver),
        }).catch(() => undefined);
    }
}

/** Every 20 s: watch live rides (also right after a restart) and close idle parked pages. */
export async function runOlaWatchTick(): Promise<void> {
    const live = (await OlaRide.find({ status: { $in: ["searching", "assigned", "cancelling"] } }, { rideId: 1, phone: 1 }).lean().catch(() => [])) as Array<{ rideId: string; phone: string }>;
    await Promise.all(live.map((r) => tickRide(r.rideId)));
    const livePhones = new Set(live.map((r) => r.phone));
    for (const [phone, v] of drivers) {
        if (!livePhones.has(phone) && Date.now() - v.at > 15 * 60_000) await dropDriver(phone);
    }
}

let started = false;
export function startOlaWatcher(): void {
    if (started) return;
    started = true;
    setTimeout(() => void runOlaWatchTick(), 15_000);
    setInterval(() => void runOlaWatchTick(), 20_000).unref();
}
