/**
 * Linked Instamart + Zepto: search every connected store.
 * A session glitch or a failed call stays on those accounts — never the guest website,
 * and never a reconnect line unless the store actually rejected the token.
 */

export function linkedGroceryTargets(
    partner: string | undefined,
    enabled: readonly string[],
): Array<"instamart" | "zepto"> {
    const wanted: Array<"instamart" | "zepto"> =
        partner === "instamart" ? ["instamart"]
        : partner === "zepto" ? ["zepto"]
        : !partner || partner === "generic" ? ["instamart", "zepto"]
        : [];
    return wanted.filter((s) => enabled.includes(s));
}

export type StoreOutcome = {
    store: string;
    error?: string | null;
    hits: number;
    calledSearch?: boolean;
    /** Live error text, so a 401 handshake is not reported as "didn't answer". */
    message?: string | null;
};

function sessionGlitch(message?: string | null): boolean {
    return /401 after successful authentication|streamable http error|server returned 401|MCP error -32001/i.test(message || "");
}

export type LinkedFailurePlan =
    | { kind: "show" }
    | { kind: "retry_linked" }
    | { kind: "reconnect"; stores: string[] }
    | { kind: "mixed"; revoked: string[]; failed: string[]; empty: string[] };

export function linkedFailurePlan(results: StoreOutcome[]): LinkedFailurePlan {
    if (results.some((r) => r.hits > 0)) return { kind: "show" };
    const revoked = results.filter((r) => r.error === "auth_expired").map((r) => r.store);
    const failed = results.filter((r) => r.error === "search_failed").map((r) => r.store);
    const empty = results.filter((r) => !r.error && r.hits === 0).map((r) => r.store);
    if (!revoked.length && !failed.length) return { kind: "show" };
    if (failed.length && !revoked.length && !empty.length) return { kind: "retry_linked" };
    if (revoked.length && !failed.length && !empty.length) return { kind: "reconnect", stores: revoked };
    return { kind: "mixed", revoked, failed, empty };
}

/** Another catalog query is worth it when the stores failed or came back empty — not when the token or the address is the problem. */
export function catalogRetryNeeded(results: StoreOutcome[]): boolean {
    if (!results.length || results.some((r) => r.hits > 0)) return false;
    if (results.every((r) => r.error === "auth_expired" || r.error === "not_connected" || sessionGlitch(r.message))) return false;
    if (results.every((r) => r.error === "unserviceable" || r.error === "no_address_coords" || sessionGlitch(r.message))) return false;
    // Another product name cannot help when the account was never searched.
    if (results.every((r) => r.error && r.calledSearch === false)) return false;
    return true;
}

/** Chat line when every linked store failed. Null means show hits or a genuine not-found. */
export function formatLinkedFailure(
    results: StoreOutcome[],
    label: (store: string) => string,
    reconnectLine: string,
): string | null {
    if (results.some((r) => r.hits > 0)) return null;
    const lines: string[] = [];
    const session = results.filter((r) => r.error === "search_failed" && sessionGlitch(r.message));
    const auth = results.filter((r) => r.error === "auth_expired");
    const unserviceable = results.filter((r) => r.error === "unserviceable");
    const failed = results.filter((r) => r.error === "search_failed" && !sessionGlitch(r.message) && r.calledSearch !== false);
    const never = results.filter(
        (r) => r.error === "search_failed" && !sessionGlitch(r.message) && r.calledSearch === false,
    );
    const empty = results.filter((r) => !r.error && r.hits === 0);
    if (auth.length && reconnectLine) lines.push(reconnectLine);
    for (const r of session) {
        lines.push(`The linked ${label(r.store)} account dropped the connection. I tried it again on that same account. Nothing was ordered.`);
    }
    for (const r of unserviceable) {
        lines.push(`${label(r.store)} doesn't deliver to this address right now.`);
    }
    for (const r of failed) {
        lines.push(`I checked ${label(r.store)} on the linked account. It didn't answer just now.`);
    }
    if (never.length) {
        const names = never.map((r) => label(r.store)).join(" and ");
        lines.push(`I couldn't reach the linked ${names} accounts, so I didn't search them — nothing was ordered.`);
    }
    if (!session.length && !auth.length && !unserviceable.length && !failed.length && !never.length && empty.length) {
        return null;
    }
    if (!lines.length) return null;
    lines.push("Reply *retry* to try the linked accounts again, or *cancel*.");
    return lines.join("\n");
}
