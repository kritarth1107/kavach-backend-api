/** Offline tests: who a care page may be about (care recipients, or a caregiver's own self care). `npm run test:self-care` */
import { isCareSubject } from "../src/services/careRecordAuth.service";
import type { IFamilyDocument } from "../src/models/family.model";
import { FamilyMemberStatus as S, FamilyRole as R } from "../src/types/family.types";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
    const ok = got === want;
    if (!ok) fail++;
    console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const family = (members: Array<[string, R, S?]>) =>
    ({ members: members.map(([userId, role, status]) => ({ userId, role, status: status ?? S.JOINED })) }) as unknown as IFamilyDocument;

const f = family([["maa", R.CARE_RECIPIENT], ["me", R.PRIMARY_CAREGIVER], ["bro", R.CO_CAREGIVER], ["viewer", R.VIEW_ONLY], ["gone", R.CARE_RECIPIENT, S.REMOVED]]);
eq("caregiver can open a care recipient", isCareSubject(f, "maa", "me"), true);
eq("primary caregiver can open their own self care", isCareSubject(f, "me", "me"), true);
eq("co-caregiver can open their own self care", isCareSubject(f, "bro", "bro"), true);
eq("caregiver cannot open another caregiver's self care", isCareSubject(f, "bro", "me"), false);
eq("view-only member has no self care", isCareSubject(f, "viewer", "viewer"), false);
eq("removed recipient is not a subject", isCareSubject(f, "gone", "me"), false);
eq("stranger is not a subject", isCareSubject(f, "x", "x"), false);

if (fail) {
    console.error(`${fail} failed`);
    process.exit(1);
}
console.log("self care rule passed");
