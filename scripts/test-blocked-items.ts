/** Offline tests: care guardrail for tobacco / gutka / vapes / alcohol. `npm run test:blocked-items` */
import { blockedReply, detectBlockedItem } from "../src/services/commerceAutomation/blockedItems";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
    const ok = got === want;
    if (!ok) fail++;
    console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const cat = (t: string) => detectBlockedItem(t)?.cat ?? null;

// Blocked — English, brands, Hindi/Hinglish, Devanagari.
const blocked: Array<[string, string]> = [
    ["Order ice burst cigarettes", "tobacco"],
    ["order classic ice burst", "tobacco"],
    ["ek packet cigarette mangwa do", "tobacco"],
    ["sutta la do", "tobacco"],
    ["2 marlboro", "tobacco"],
    ["gold flake chahiye", "tobacco"],
    ["bidi ka bundle", "tobacco"],
    ["beedi bhejo", "tobacco"],
    ["cigar order karo", "tobacco"],
    ["hookah flavour", "tobacco"],
    ["tambaku chahiye", "tobacco"],
    ["सिगरेट मंगवा दो", "tobacco"],
    ["gutka", "gutka"],
    ["gutkha bhejo", "gutka"],
    ["rajnigandha pan masala", "gutka"],
    ["zarda", "gutka"],
    ["khaini chahiye", "gutka"],
    ["गुटखा", "gutka"],
    ["vape", "vape"],
    ["e-cigarette", "vape"],
    ["e cig pods", "vape"],
    ["daru mangwa do", "alcohol"],
    ["daaru", "alcohol"],
    ["sharab chahiye", "alcohol"],
    ["2 beer", "alcohol"],
    ["kingfisher beer", "alcohol"],
    ["old monk rum", "alcohol"],
    ["red wine", "alcohol"],
    ["whisky", "alcohol"],
    ["शराब", "alcohol"],
];
for (const [t, c] of blocked) eq(`blocked: ${t}`, cat(t), c);

// Allowed — food and look-alikes must NOT trip the backstop.
const allowed = [
    "amul milk 1 litre",
    "ginger tea",
    "ginger ale",
    "root beer",
    "ginger beer",
    "rumali roti",
    "paneer butter masala",
    "pan cake mix",
    "chocolate cake",
    "choco lava cake",
    "non-alcoholic beer",
    "nicotine gum",
    "classic salted chips",
    "paan ice cream",
    "vinegar",
    "biscuit",
    "Haldiram's bhujia",
    "gingerbread",
    "rumble",
    "begin",
];
for (const t of allowed) eq(`allowed: ${t}`, cat(t), null);

// Reply: warm, short, elder's language, no preaching.
const hi = blockedReply("tobacco", "ek cigarette mangwa do", "hinglish");
eq("hinglish reply", hi, "Maaf kijiye, cigarette ya tambaku main order nahi kar sakti 🙏 Aapki sehat sabse zaroori hai. Kuch aur chahiye to bataiye.");
const en = blockedReply("alcohol", "order 2 beers", "en");
eq("english reply", en, "Sorry, I can't order alcohol 🙏 Your health matters most. Is there something else I can get you?");
eq("guess hindi from text", blockedReply("alcohol", "daru chahiye").startsWith("Maaf kijiye"), true);
eq("guess english from text", blockedReply("tobacco", "Order ice burst cigarettes").startsWith("Sorry"), true);
eq("no OTP in reply", /otp/i.test(hi + en), false);

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
