/**
 * Durable family memory. The chat window drops old lines. This brief is rebuilt
 * from what was actually saved, so a later reply still knows the person, the doses, and the record.
 */

export type LearnedMemory = {
    facts: string[];
    record: string;
    medicines: Array<{ name: string; time?: string; status?: string }>;
    routines: string[];
    reminders: Array<{ text: string; when: string }>;
    nameToUse?: string;
};

export function learnBrief(mem: LearnedMemory): string {
    const lines: string[] = [];
    if (mem.nameToUse?.trim()) lines.push(`Call them ${mem.nameToUse.trim()}.`);
    if (mem.record.trim()) lines.push(`Record: ${mem.record.trim().slice(0, 800)}`);
    for (const fact of mem.facts.slice(-40)) {
        const text = fact.trim();
        if (text) lines.push(`Fact: ${text}`);
    }
    for (const med of mem.medicines) {
        const name = med.name.trim();
        if (!name) continue;
        const status = (med.status || "saved").trim();
        const when = med.time?.trim() ? ` at ${med.time.trim()}` : "";
        lines.push(`Dose ${name}${when}: ${status}.`);
    }
    for (const reminder of mem.reminders.slice(-20)) {
        if (reminder.text.trim()) lines.push(`Reminder: ${reminder.text.trim()} (${reminder.when.trim() || "unspecified"}).`);
    }
    for (const routine of mem.routines.slice(-20)) {
        if (routine.trim()) lines.push(`Routine: ${routine.trim()}`);
    }
    return lines.join("\n").slice(0, 4000);
}
