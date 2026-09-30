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

export type StoreOutcome = { store: string; error?: string | null; hits: number; calledSearch?: boolean };

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
    if (results.every((r) => r.error === "auth_expired" || r.error === "not_connected")) return false;
    if (results.every((r) => r.error === "unserviceable" || r.error === "no_address_coords")) return false;
    return true;
}

/** Chat line when every linked store failed. Null means show hits or a genuine not-found. */
export function formatLinkedFailure(
    results: StoreOutcome[],
    label: (store: string) => string,
    reconnectLine: string,
): string | null {
    const plan = linkedFailurePlan(results);
    if (plan.kind === "show") return null;
    if (plan.kind === "retry_linked") {
        const names = results.map((r) => label(r.store)).join(" and ");
        const searched = results.some((r) => r.calledSearch);
        if (!searched) {
            return `I couldn't reach the linked ${names} accounts, so I didn't search them — nothing was ordered.\nReply *retry* to search the linked accounts, or *cancel*.`;
        }
        return `I checked ${names} on the linked accounts. They didn't answer just now — nothing was ordered.\nReply *retry* to try the linked accounts again, or *cancel*.`;
    }
    if (plan.kind === "reconnect") return reconnectLine;
    const lines = [
        plan.revoked.length ? reconnectLine : "",
        ...plan.failed.map((s) => `• ${label(s)} didn't answer on the linked account.`),
        ...plan.empty.map((s) => `• ${label(s)}: nothing matching right now.`),
        `Reply *retry* to try the linked accounts again, or *cancel*.`,
    ].filter(Boolean);
    return lines.join("\n");
}
