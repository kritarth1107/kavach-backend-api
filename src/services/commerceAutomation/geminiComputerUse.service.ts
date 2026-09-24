/**
 * Vertex Gemini multimodal → structured browser actions.
 * Chat brain stays on existing Gemini path; this is browsing AI only.
 * Do NOT switch to Claude/OpenAI computer-use.
 */
import { GoogleAuth } from "google-auth-library";

export type BrowserActionType =
    | "click"
    | "type"
    | "press"
    | "scroll"
    | "wait"
    | "goto"
    | "done"
    | "need_otp"
    | "need_user_confirm";

export type BrowserAction = {
    type: BrowserActionType;
    /** Normalized viewport coords 0–1000 (Gemini style) or CSS selector */
    x?: number;
    y?: number;
    selector?: string;
    text?: string;
    key?: string;
    url?: string;
    direction?: "up" | "down";
    ms?: number;
    /** Human-readable reason / confirm card body */
    message?: string;
    /** Structured confirm payload when need_user_confirm */
    confirm?: {
        items?: string[];
        totalLabel?: string;
        addressLabel?: string;
    };
};

export type ComputerUseObservation = {
    screenshotBase64: string;
    mimeType?: string;
    url: string;
    title?: string;
    accessibilityHint?: string;
    goal: string;
    playbookHint?: string;
    step: number;
    maxSteps: number;
    otpProvided?: boolean;
    userConfirmed?: boolean;
};

function gcpProjectId(): string {
    return (
        process.env.GCP_PROJECT_ID?.trim() ||
        process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
        "kavach-care"
    );
}

function visionLocation(): string {
    if (process.env.VERTEX_VISION_LOCATION?.trim()) {
        return process.env.VERTEX_VISION_LOCATION.trim();
    }
    const model = (
        process.env.VERTEX_BROWSER_MODEL?.trim() ||
        process.env.VERTEX_VISION_MODEL?.trim() ||
        "gemini-3.5-flash"
    ).toLowerCase();
    if (model.includes("flash")) {
        return process.env.GCP_REGION?.trim() || "asia-south1";
    }
    return process.env.VERTEX_LOCATION?.trim() || process.env.GCP_REGION?.trim() || "asia-south1";
}

function browserModel(): string {
    return (
        process.env.VERTEX_BROWSER_MODEL?.trim() ||
        process.env.VERTEX_VISION_MODEL?.trim() ||
        "gemini-3.5-flash"
    );
}

async function getAccessToken(): Promise<string | null> {
    try {
        const auth = new GoogleAuth({
            scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        });
        const client = await auth.getClient();
        const token = await client.getAccessToken();
        return token.token || null;
    } catch (err) {
        console.warn(
            "GCP token unavailable for browser computer-use:",
            err instanceof Error ? err.message : err,
        );
        return null;
    }
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
    let text = raw.trim();
    if (text.startsWith("```")) {
        text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
        return null;
    }
}

const SYSTEM_PROMPT = `You are Saheli's private browsing AI for Indian family caregiving.
You control a browser via structured actions. Chat brain is separate — you only output browser actions.

HARD SAFETY RULES:
1. NEVER submit payment, tap Pay, confirm UPI, or complete checkout without first emitting need_user_confirm and waiting for userConfirmed=true. Prefer Cash on Delivery (COD) when the site offers it; never invent item names or prices.
2. RIDES (BOOK_RIDE / Uber / Ola / Rapido): NEVER tap Request / Confirm ride / Book / Schedule without first emitting need_user_confirm with fare options (confirm.items) and waiting for userConfirmed=true. Scrape real fares from the page — never invent stub prices. On done after book, include driver name, car, and plate in message when visible. If CAPTCHA, blocked, or service unavailable in the user's area, emit done with a clear error message (no fake driver).
3. If an OTP / SMS login code is required, emit need_otp with a short WhatsApp message. Do not invent OTPs.
3b. PHARMACY LOGIN: Deterministic bootstrap already sends Continue/Send OTP at most ONCE. NEVER click Continue, Get OTP, Send OTP, Resend, or Request OTP on Apollo/PharmEasy/1mg login. If an OTP field is visible, emit need_otp immediately and stop. Never re-trigger SMS.
4. Prefer OTC medicine/grocery goals. Never diagnose. Only fulfill what the user asked.
5. Max steps are limited — be efficient.

Respond with a single JSON object (no markdown):
{
  "actions": [
    {
      "type": "click"|"type"|"press"|"scroll"|"wait"|"goto"|"done"|"need_otp"|"need_user_confirm",
      "x": 0-1000,
      "y": 0-1000,
      "selector": "optional css",
      "text": "for type",
      "key": "Enter|Tab|...",
      "url": "for goto",
      "direction": "up"|"down",
      "ms": 500,
      "message": "user-facing WhatsApp line for need_otp / need_user_confirm / done",
      "confirm": { "items": ["Vit C ×1"], "totalLabel": "₹199", "addressLabel": "Home" }
    }
  ],
  "thought": "brief internal note"
}

Coordinates x,y are normalized 0–1000 over the screenshot (0,0 = top-left).
Emit 1–3 actions per turn. Prefer need_user_confirm when cart/checkout totals are visible.`;

function normalizeAction(raw: unknown): BrowserAction | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const type = String(r.type || "").toLowerCase() as BrowserActionType;
    const allowed: BrowserActionType[] = [
        "click",
        "type",
        "press",
        "scroll",
        "wait",
        "goto",
        "done",
        "need_otp",
        "need_user_confirm",
    ];
    if (!allowed.includes(type)) return null;
    const action: BrowserAction = { type };
    if (typeof r.x === "number") action.x = Math.max(0, Math.min(1000, r.x));
    if (typeof r.y === "number") action.y = Math.max(0, Math.min(1000, r.y));
    if (r.selector) action.selector = String(r.selector).slice(0, 200);
    if (r.text != null) action.text = String(r.text).slice(0, 500);
    if (r.key) action.key = String(r.key).slice(0, 40);
    if (r.url) action.url = String(r.url).slice(0, 500);
    if (r.direction === "up" || r.direction === "down") action.direction = r.direction;
    if (typeof r.ms === "number") action.ms = Math.max(0, Math.min(15000, r.ms));
    if (r.message) action.message = String(r.message).slice(0, 600);
    if (r.confirm && typeof r.confirm === "object") {
        const c = r.confirm as Record<string, unknown>;
        action.confirm = {
            items: Array.isArray(c.items)
                ? c.items.map((i) => String(i).slice(0, 80)).slice(0, 12)
                : undefined,
            totalLabel: c.totalLabel ? String(c.totalLabel).slice(0, 40) : undefined,
            addressLabel: c.addressLabel ? String(c.addressLabel).slice(0, 120) : undefined,
        };
    }
    return action;
}

/**
 * Ask Gemini for the next browser action(s) given a screenshot observation.
 */
export async function planBrowserActions(
    obs: ComputerUseObservation,
): Promise<{ actions: BrowserAction[]; thought?: string; modelUsed: string }> {
    const model = browserModel();
    const token = await getAccessToken();
    if (!token) {
        // Fail closed into confirm/OTP UX rather than inventing clicks
        return {
            modelUsed: model,
            thought: "no_gcp_token",
            actions: [
                {
                    type: "need_user_confirm",
                    message:
                        "I can't drive the browser right now (AI vision unavailable). Reply *confirm* if you want me to keep your request queued, or *cancel*.",
                    confirm: { items: [obs.goal.slice(0, 80)] },
                },
            ],
        };
    }

    const project = gcpProjectId();
    const location = visionLocation();
    const host =
        location === "global"
            ? "https://aiplatform.googleapis.com"
            : `https://${location}-aiplatform.googleapis.com`;
    const url = `${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;

    const meta = [
        `Goal: ${obs.goal}`,
        `Step: ${obs.step}/${obs.maxSteps}`,
        `URL: ${obs.url}`,
        obs.title ? `Title: ${obs.title}` : "",
        obs.playbookHint ? `Playbook: ${obs.playbookHint}` : "",
        obs.accessibilityHint ? `A11y: ${obs.accessibilityHint.slice(0, 800)}` : "",
        `otpProvided: ${obs.otpProvided ? "true" : "false"}`,
        `userConfirmed: ${obs.userConfirmed ? "true" : "false"}`,
    ]
        .filter(Boolean)
        .join("\n");

    const res = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "x-goog-user-project": project,
        },
        body: JSON.stringify({
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: `${SYSTEM_PROMPT}\n\n${meta}` },
                        {
                            inlineData: {
                                mimeType: obs.mimeType || "image/png",
                                data: obs.screenshotBase64,
                            },
                        },
                    ],
                },
            ],
            generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 1024,
            },
        }),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(`Gemini browser plan failed (${res.status}): ${body.slice(0, 240)}`);
        return {
            modelUsed: model,
            thought: `http_${res.status}`,
            actions: [
                {
                    type: "need_otp",
                    message:
                        "The site may need a login code. If you got an SMS OTP, paste it here — or reply *cancel*.",
                },
            ],
        };
    }

    const json = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const rawText = json.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
    if (!rawText) {
        return { modelUsed: model, actions: [{ type: "wait", ms: 800 }] };
    }

    const parsed = parseJsonObject(rawText);
    const rawActions = Array.isArray(parsed?.actions) ? parsed!.actions : [];
    const actions = rawActions
        .map(normalizeAction)
        .filter((a): a is BrowserAction => Boolean(a))
        .slice(0, 3);

    if (!actions.length) {
        return {
            modelUsed: model,
            thought: String(parsed?.thought || "").slice(0, 200),
            actions: [{ type: "wait", ms: 500 }],
        };
    }

    // Safety: strip payment / silent-book clicks unless user already confirmed
    if (!obs.userConfirmed) {
        const isRide = /\bBOOK_RIDE\b/i.test(obs.goal) || /\b(uber|ola|rapido)\b/i.test(obs.goal + " " + (obs.playbookHint || ""));
        for (const a of actions) {
            if (a.type === "click" || a.type === "press") {
                const t = `${a.text || ""} ${a.selector || ""} ${a.message || ""}`.toLowerCase();
                if (/\b(pay|upi|place\s*order|confirm\s*payment|checkout)\b/.test(t)) {
                    return {
                        modelUsed: model,
                        thought: "blocked_silent_pay",
                        actions: [
                            {
                                type: "need_user_confirm",
                                message:
                                    "Ready to pay — please confirm item, total, and address before I continue.",
                                confirm: a.confirm,
                            },
                        ],
                    };
                }
                if (
                    isRide &&
                    /\b(request\s*(uber|ride)?|confirm\s*(ride|booking|trip)|book\s*(now|ride|uber)|schedule\s*ride|reserve)\b/.test(
                        t,
                    )
                ) {
                    return {
                        modelUsed: model,
                        thought: "blocked_silent_book",
                        actions: [
                            {
                                type: "need_user_confirm",
                                message:
                                    a.message ||
                                    "Ready to book — reply *book* / *confirm* with fare + ride type check, or *cancel*.",
                                confirm: a.confirm,
                            },
                        ],
                    };
                }
            }
        }
    }

    return {
        modelUsed: model,
        thought: parsed?.thought ? String(parsed.thought).slice(0, 200) : undefined,
        actions,
    };
}
