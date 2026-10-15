/** Run `jobs` with at most `size` in flight. A throw in one job does not cancel the others. */
export async function runPool<T>(jobs: Array<() => Promise<T>>, size: number): Promise<T[]> {
    const out: T[] = new Array(jobs.length);
    let next = 0;
    const workers = Math.max(1, Math.min(size, jobs.length));
    async function worker(): Promise<void> {
        for (;;) {
            const i = next++;
            if (i >= jobs.length) return;
            out[i] = await jobs[i]!();
        }
    }
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return out;
}
