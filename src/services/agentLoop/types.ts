/** One Pro decision. Extra keys are rejected. One tool only. */

export const PRO_KEYS = ["goal", "step", "tool", "tool_args", "say", "ask", "done", "save_facts"] as const;

export type SaveFact = { text: string };

export type ProDecision = {
    goal: string;
    step: string;
    tool: string | null;
    tool_args: Record<string, unknown>;
    say: string;
    ask: string | null;
    done: boolean;
    save_facts: SaveFact[];
};

export type ToolResult = { ok: boolean; data?: unknown; error?: string };

export type GoalStatus = "open" | "waiting_confirm" | "waiting_user" | "done" | "dropped";

export type GoalHistoryRow = {
    step: string;
    tool: string | null;
    argsHash: string;
    ok: boolean;
    error?: string;
    at: string;
};

export type GoalDoc = {
    id: string;
    elderId: string;
    goal: string;
    step: string;
    status: GoalStatus;
    tool: string | null;
    toolArgs: Record<string, unknown>;
    query: string | null;
    page: number;
    hits: Array<{ id: string; name: string; price?: string; size?: string }>;
    lastResult: unknown;
    waitingFor: string | null;
    language: string;
    toldFare: number | null;
    toldPickup: string | null;
    history: GoalHistoryRow[];
    updatedAt: string;
};

export type ElderContext = {
    elderId: string;
    phone: string;
    nameToUse: string;
    language: string;
    allergies: string[];
    dietRules: string[];
    blockedMedicines: string[];
    facts: string[];
    blockedFacts: string[];
    medicines: Array<{ name: string; time: string; status: string; lastRemindedAt: string | null }>;
    openGoal: GoalDoc | null;
    lastMessages: string[];
    signals: unknown[];
    pickupLabel: string | null;
    /** Who sent this message. Absent on older callers. */
    speaker?: { name: string; role: string } | null;
    /** Names in this family. Absent on older callers. */
    household?: { caregivers: string[]; careRecipients: string[] } | null;
    record?: string;
    reminders?: Array<{ text: string; when: string; held: boolean }>;
    readings?: Array<{ kind: string; value: string }>;
    routines?: string[];
};

export type LoopResult = {
    skipped?: boolean;
    say: string;
    blockedText?: string;
    /** True when the spoken reply was replaced because it left out the tool's items. */
    grounded?: boolean;
    enqueueFeedback: boolean;
    decisions: ProDecision[];
    toolTrace: Array<{ name: string; args: Record<string, unknown>; result?: unknown }>;
    goal: GoalDoc | null;
};
