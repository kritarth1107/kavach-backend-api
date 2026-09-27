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
import { OlaMsg, orderRideTypes, pickRideType, type OlaConfirmInfo, type OlaDriverInfo } from "./olaCopy";
import { FakeOlaDriver, PlaywrightOlaDriver, type OlaDriver } from "./olaDriver";

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

/** Test numbers only (mock webhook): script Ola's page states and speed the clock up. */
export function setOlaTestScenario(phone: string, scenario: string, timeScale = 1): boolean {
    if (!isTestPhone(phone)) return false;
    scenarios.set(phone, { scenario, timeScale: Math.min(Math.max(timeScale, 1), 60) });
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
        const s = scenarios.get(input.phone) || { scenario: "assigned", timeScale: 1 };
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

function fallbackText(lang: string | null | undefined, p?: RidePlace, d?: RidePlace): string {
    return OlaMsg.failed(lang, olaLink(p, d), uberLink(p, d), rapidoLink(p, d));
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
                const q = pl.address || pl.raw || pl.shortLabel || "";
                const g = q ? await geocodePlace(q).catch(() => null) : null;
                if (g?.ok && g.place.lat != null && g.place.lng != null) draft[k] = { ...pl, lat: g.place.lat, lng: g.place.lng };
                else log("ola_no_point", { end: k, phone: input.phone.slice(-4) });
            }
        }
        const url = olaLink(draft.pickup, draft.drop);
        let types: Awaited<ReturnType<OlaDriver["rideTypes"]>> = [];
        try {
            const drv = await driverFor(input, true);
            if (url) await drv.open(url);
            types = orderRideTypes(await drv.rideTypes(), draft.vehicle || "cab");
        } catch (err) {
            log("ola_types_failed", { error: err instanceof Error ? err.message.slice(0, 160) : String(err) });
        }
        const cur = await current(input.phone, token, ["ola_loading"]);
        if (!cur) return;
        if (!types.length) {
            log("ola_types_empty", { phone: input.phone.slice(-4), hadUrl: Boolean(url) });
            await saveDraft(input.phone, null);
            await dropDriver(input.phone);
            await send(input, fallbackText(lang, draft.pickup, draft.drop));
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

export async function handleOlaTurn(input: OlaTurnInput, draft: RideDraft, text: string): Promise<{ text: string; draft?: RideDraft | null }> {
    const t = text.trim();
    const lang = draft.ola?.lang ?? null;
    const token = draft.ola?.token || "";
    const hi = /^hi/i.test(String(lang || ""));

    // Booked: search running / driver on the way.
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
            const r = await drv.choose(type).catch(() => "failed" as const);
            if (r === "confirm") return showConfirmCard(input, token, drv);
            if (r !== "login") return fail(input, token, "reopen_failed");
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
            const r = await drv.choose(type).catch(() => "failed" as const);
            if (r === "confirm") await showConfirmCard(input, token, drv);
            else if (r === "login") {
                const cur = await current(input.phone, token);
                if (!cur) return;
                cur.phase = "ola_confirm_signin";
                await saveDraft(input.phone, cur);
                await send(input, OlaMsg.confirmSignIn(lang, type, cur.ola!.phoneE164 || e164(input.phone)));
            } else await fail(input, token, "choose_failed");
        }, "choose");
        return { text: OlaMsg.fetchingFare(lang), draft };
    }
    draft.phase = "ola_confirm_signin";
    await saveDraft(input.phone, draft);
    return { text: OlaMsg.confirmSignIn(lang, type, draft.ola.phoneE164 || e164(input.phone)), draft };
}

async function fail(input: OlaTurnInput, token: string, why: string, extra?: string): Promise<void> {
    const cur = await current(input.phone, token);
    if (!cur) return;
    log("ola_failed", { why });
    await saveDraft(input.phone, null);
    await dropDriver(input.phone);
    await send(input, [extra, fallbackText(cur.ola?.lang, cur.pickup, cur.drop)].filter(Boolean).join("\n\n"));
}

async function signIn(input: OlaTurnInput, token: string): Promise<void> {
    const cur = await current(input.phone, token, ["ola_signing_in"]);
    if (!cur) return;
    const lang = cur.ola?.lang ?? null;
    const drv = await driverFor(input);
    const where = await drv.choose(cur.ola!.chosen!).catch(() => "failed" as const);
    if (where === "confirm") return showConfirmCard(input, token, drv);
    if (where !== "login") return fail(input, token, "no_login_page");
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
        const w = await drv.choose(cur.ola!.chosen!).catch(() => "failed" as const);
        if (w !== "confirm") return fail(input, token, "no_confirm_after_login");
    }
    await showConfirmCard(input, token, drv);
}

async function showConfirmCard(input: OlaTurnInput, token: string, drv: OlaDriver): Promise<void> {
    const cur = await current(input.phone, token);
    if (!cur) return;
    const lang = cur.ola?.lang ?? null;
    const info = await drv.readConfirm(cur.ola!.chosen!).catch(() => null);
    if (!info?.fare) return fail(input, token, "no_fare");
    if (!(await drv.ensureCash().catch(() => false))) return fail(input, token, "not_cash", OlaMsg.notCash(lang));
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
    const r = await drv.book().catch(() => "failed" as const);
    log("ola_book", { result: r });
    if (r === "failed") return fail(input, token, "book_failed");
    const rideId = randomUUID();
    const sc = drv.kind === "fake" ? scenarios.get(input.phone) || { scenario: "assigned", timeScale: 1 } : null;
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
        fare: c.fare,
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
