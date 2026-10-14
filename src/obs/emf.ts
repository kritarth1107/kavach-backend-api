/** One CloudWatch Embedded Metric Format line. The log group extracts it. */

type Count = { calls?: number; errors?: number; throttles?: number; latencyMs?: number; sent?: number; failed?: number };

export function note(namespace: string, role: string, counts: Count = {}): void {
    const metrics: Array<{ Name: string; Unit: string }> = [];
    const body: Record<string, string | number> = { Role: role };
    const add = (name: string, unit: string, value: number | undefined) => {
        if (value == null) return;
        metrics.push({ Name: name, Unit: unit });
        body[name] = value;
    };
    add("Calls", "Count", counts.calls);
    add("Errors", "Count", counts.errors);
    add("Throttles", "Count", counts.throttles);
    add("LatencyMs", "Milliseconds", counts.latencyMs);
    add("Sent", "Count", counts.sent);
    add("Failed", "Count", counts.failed);
    if (!metrics.length) return;
    console.log(JSON.stringify({
        _aws: {
            Timestamp: Date.now(),
            CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [["Role"], []], Metrics: metrics }],
        },
        ...body,
    }));
}

export function noteCall(namespace: string, role: string, started: number, status: number | null, failed: boolean): void {
    note(namespace, role, {
        calls: 1,
        errors: failed && status !== 429 ? 1 : 0,
        throttles: status === 429 ? 1 : 0,
        latencyMs: Date.now() - started,
    });
}
