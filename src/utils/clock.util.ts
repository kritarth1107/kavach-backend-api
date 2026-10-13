/**
 * The time, as the reminder, delivery and escalation code sees it. Production reads the real clock; tests set a fake
 * one (scripts/test-escalation-e2e.ts runs whole days of the real scheduler functions in seconds).
 */
let fake: number | null = null;

export function clockNow(): Date {
    return fake == null ? new Date() : new Date(fake);
}

/** Tests only: pin the clock (null = the real one). */
export function setClockForTest(at: Date | string | number | null): void {
    fake = at == null ? null : new Date(at).getTime();
}

/** Tests only: move the fake clock on. */
export function advanceClockForTest(ms: number): Date {
    fake = (fake ?? Date.now()) + ms;
    return new Date(fake);
}
