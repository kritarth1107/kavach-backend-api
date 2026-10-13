/**
 * The test database for one suite. Locally the DB checks run only when TEST_MONGODB_URI points at a throwaway mongod;
 * in CI (CI=true) a missing URI fails the suite instead of skipping it (founder 2026-10-13: 9 suites had been passing
 * without ever touching a database). Each suite gets its own database name on the same server.
 */
export function testDbUri(name: string): string | undefined {
    const raw = process.env.TEST_MONGODB_URI?.trim();
    if (!raw) {
        if (process.env.CI) throw new Error(`TEST_MONGODB_URI is not set: the ${name} database checks must run in CI`);
        return undefined;
    }
    if (/cosmos|azure|mongodb\+srv|firestore/i.test(raw)) throw new Error("TEST_MONGODB_URI must be a throwaway local DB");
    const m = raw.match(/^(mongodb:\/\/[^/]+)(\/[^?]*)?(\?.*)?$/);
    if (!m) throw new Error("TEST_MONGODB_URI must look like mongodb://host:port[/db]");
    return `${m[1]}/${name}${m[3] ?? ""}`;
}
