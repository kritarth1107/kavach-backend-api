/** The console's operations page helpers: next run of a cron line (IST), masked log lines, the RDS XML reader. */
import assert from "node:assert/strict";
import { blocks, JOBS, mask, nextRun, tag } from "../src/admin/infra/ops";

// 21 Oct 2026 00:30 IST = 20 Oct 19:00 UTC
const now = Date.parse("2026-10-20T19:00:00Z");
assert.equal(nextRun("0 4 * * *", now), "2026-10-20T22:30:00.000Z"); // 04:00 IST
assert.equal(nextRun("*/5 * * * *", now), "2026-10-20T19:05:00.000Z");
assert.equal(nextRun("0 8 * * 0", now), "2026-10-25T02:30:00.000Z"); // Sunday 08:00 IST
assert.equal(mask("sent to +91 98765 43210 and a@b.com ok"), "sent to [number] and [email] ok");
const xml = "<DBCluster><DBClusterIdentifier>kavach-ai-pg</DBClusterIdentifier><DBClusterMember><DBInstanceIdentifier>i1</DBInstanceIdentifier><IsClusterWriter>true</IsClusterWriter></DBClusterMember></DBCluster>";
assert.equal(tag(blocks(xml, "DBCluster")[0], "DBClusterIdentifier"), "kavach-ai-pg");
assert.equal(tag(blocks(xml, "DBClusterMember")[0], "IsClusterWriter"), "true");
assert.ok(JOBS.some((j) => j.name === "Nightly trainer" && j.cron === "0 4 * * *"));
assert.equal(new Set(JOBS.map((j) => j.name)).size, JOBS.length);
console.log("admin ops ok");
