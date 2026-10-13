/**
 * When a medicine reminder goes out. (The old v1 chat's reply guards that lived here, which matched what people said
 * against fixed phrases, went with the old brain: trust plan A1, founder D9.)
 */

/** The dose reminder's window, in minutes after its time: the first send, then the retries at +1 and +3 (trust plan B1.7). */
export const DOSE_WINDOW_MIN = 4;

/** Send the medicine WhatsApp in the minute it is due, then again if there is no reply. */
export function medicineDueWindow(minutesSince: number, status: string): "dose_due" | "followup" | null {
    if (status === "completed") return null;
    if (minutesSince >= 0 && minutesSince <= DOSE_WINDOW_MIN) return "dose_due";
    if (minutesSince >= 15 && minutesSince <= 60) return "followup";
    return null;
}
