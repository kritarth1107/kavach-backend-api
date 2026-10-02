/** Offline tests: only caregivers may sign in to the dashboard. `npm run test:login-gate` */
import { isCareRecipientOnly } from "../src/services/loginGate";
import { FamilyMemberStatus as S, FamilyRole as R } from "../src/types/family.types";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
    const ok = got === want;
    if (!ok) fail++;
    console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const m = (userId: string, role: R, status: S = S.JOINED) => ({ userId, role, status });

eq("recipient only is refused", isCareRecipientOnly("u", [m("u", R.CARE_RECIPIENT), m("c", R.PRIMARY_CAREGIVER)]), true);
eq("recipient in two families is refused", isCareRecipientOnly("u", [m("u", R.CARE_RECIPIENT), m("u", R.CARE_RECIPIENT, S.PENDING)]), true);
eq("primary caregiver may sign in", isCareRecipientOnly("u", [m("u", R.PRIMARY_CAREGIVER)]), false);
eq("co-caregiver may sign in", isCareRecipientOnly("u", [m("u", R.CO_CAREGIVER)]), false);
eq("recipient who also cares for someone may sign in", isCareRecipientOnly("u", [m("u", R.CARE_RECIPIENT), m("u", R.CO_CAREGIVER)]), false);
eq("new user with no family may sign in", isCareRecipientOnly("u", [m("c", R.PRIMARY_CAREGIVER)]), false);
eq("removed recipient row is ignored", isCareRecipientOnly("u", [m("u", R.CARE_RECIPIENT, S.REMOVED)]), false);

if (fail) {
    console.error(`${fail} failed`);
    process.exit(1);
}
console.log("dashboard login gate passed");
