/**
 * Saheli's fixed flow lines (store search, address, list, confirm, cancel) were English-only, so a
 * Hindi/Hinglish chat got English mid-conversation. When her latest message was Hindi/Hinglish,
 * these exact templates are rewritten; anything else (model replies, product names) is untouched.
 */
type Rule = [RegExp, string];
const RULES: Rule[] = [
    [/I can order medicines from \*Apollo\* or \*PharmEasy\*, groceries & food from \*Instamart, Swiggy, Zepto, Blinkit\* or \*Zomato\*, and send you a ready \*Uber, Ola or Rapido\* link for a ride\./g, "Main *Apollo* ya *PharmEasy* se dawaiyan, *Instamart, Swiggy, Zepto, Blinkit* ya *Zomato* se saamaan aur khana mangwa sakti hoon, aur ride ke liye *Uber, Ola ya Rapido* ka taiyaar link bhej sakti hoon."],
    [/Zepto isn't available for me right now 🙏 I can get it from Instamart or Blinkit instead\./g, "Zepto abhi mere liye available nahi hai 🙏 Main Instamart ya Blinkit se mangwa sakti hoon."],
    [/To order on Zepto directly, link it once: Dashboard → Integrations → Zepto\./g, "Zepto se seedha order ke liye ek baar link kijiye: Dashboard → Integrations → Zepto."],
    [/\(Zepto isn't available for me right now\. /g, "(Zepto abhi mere liye available nahi hai. "],
    [/Zomato isn't available for me right now 🙏 I can get it from Swiggy instead\./g, "Zomato abhi mere liye available nahi hai 🙏 Main Swiggy se mangwa sakti hoon."],
    [/I'm working on Tata 1mg ordering 🙏 I'll tell you as soon as it's live\. Meanwhile I can get it from Apollo or PharmEasy\./g, "Tata 1mg se order par main kaam kar rahi hoon 🙏 Jaise hi shuru hoga, aapko bata dungi. Tab tak Apollo ya PharmEasy se mangwa sakti hoon."],
    [/\*([^*]+)\* isn't letting me sign in right now\./g, "*$1* abhi mujhe sign in nahi karne de raha."],
    [/(\w[\w ]*) isn't letting me in right now\./g, "$1 abhi mujhe andar nahi jaane de raha."],
    [/Searching \*([^*]+)\* for "([^"]+)" near (🏠 )?\*([^*]+)\* 🔎 — I'll send the options in a moment\./g, "*$1* par \"$2\" dhoondh rahi hoon, $3*$4* ke liye 🔎 — options abhi yahin bhejti hoon."],
    [/Searching \*([^*]+)\* for "([^"]+)" near (🏠 )?\*([^*]+)\* 🔎 — this one takes a couple of minutes, I'll send the options\./g, "*$1* par \"$2\" dhoondh rahi hoon, $3*$4* ke liye 🔎 — isme do-teen minute lagte hain, options bhej dungi."],
    [/Comparing \*([^*]+)\* and \*([^*]+)\* for "([^"]+)" near (🏠 )?\*([^*]+)\* 🔎 — I'll send the prices in a moment\./g, "*$1* aur *$2* par \"$3\" ke daam dekh rahi hoon, $4*$5* ke liye 🔎 — abhi bhejti hoon."],
    [/^Got it 👍 Deliver to \*([^*]+)\* (🏠 )?\(([^)]+)\)\?/gm, "Theek hai 👍 *$1* $2($3) par bhejun?"],
    [/^Deliver to \*([^*]+)\* (🏠 )?\(([^)]+)\)\?/gm, "*$1* $2($3) par bhejun?"],
    [/Reply \*yes\*, or pick another saved place:/g, "*haan* likhiye, ya koi aur jagah chuniye:"],
    [/Reply \*yes\*, or send another address\./g, "*haan* likhiye, ya doosra pata bhejiye."],
    [/^(🏠 )?\*([^*]+)\* it is\./gm, "$1*$2* par bhejungi."],
    [/^🏠 Sending to \*([^*]+)\*\./gm, "🏠 *$1* par bhejungi."],
    [/^Found on \*([^*]+)\* on \*([^*]+)\* 🛒/gm, "*$2* par *$1* mein mila 🛒"],
    [/^Found on \*([^*]+)\* (🛒|💊)/gm, "*$1* par mila $2"],
    [/^Prices for "([^"]+)" 🛒/gm, "\"$1\" ke daam 🛒"],
    [/Reply \*1\*, \*2\* or \*3\* \(or \*confirm\* for #1\)\. Cash on Delivery only\./g, "*1*, *2* ya *3* likhiye (ya #1 ke liye *confirm*). Sirf Cash on Delivery."],
    [/Reply \*1\* or \*2\* \(or \*confirm\* for #1\)\. Cash on Delivery only\./g, "*1* ya *2* likhiye (ya #1 ke liye *confirm*). Sirf Cash on Delivery."],
    [/Reply \*1\*, \*2\* or \*3\* to pick, or \*cancel\*\. Cash on Delivery only\./g, "Chunne ke liye *1*, *2* ya *3* likhiye, ya *cancel*. Sirf Cash on Delivery."],
    [/Reply \*1\*, \*2\* or \*3\* to pick a dish, send a dish name, or \*cancel\*\. Cash on Delivery only\./g, "Dish chunne ke liye *1*, *2* ya *3* likhiye, dish ka naam bhejiye, ya *cancel*. Sirf Cash on Delivery."],
    [/Reply \*confirm\* to order \(I'll ask for the OTP next\), or \*cancel\*\. Cash on Delivery only\./g, "Order karna ho to *confirm* likhiye (phir OTP poochungi), ya *cancel*. Sirf Cash on Delivery."],
    [/To go ahead, reply \*confirm\* — I'll then open \*([^*]+)\* and ask you for the login OTP\. Or \*cancel\*\./g, "Aage badhne ke liye *confirm* likhiye — phir main *$1* kholkar login OTP poochungi. Ya *cancel*."],
    [/Pick a number from the list first \(e\.g\. \*1\*\), then reply \*confirm\*\. Or \*cancel\*\./g, "Pehle list se number chuniye (jaise *1*), phir *confirm* likhiye. Ya *cancel*."],
    [/^🏠 Delivering to \*([^*]+)\*/gm, "🏠 *$1* par delivery"],
    [/Opening \*([^*]+)\*'s menu on Swiggy 🍽️ — one moment\./g, "Swiggy par *$1* ka menu khol rahi hoon 🍽️ — ek minute."],
    [/_Zomato shows prices only after sign-in — you'll see the exact total on the final card before anything is ordered\._/g, "_Zomato sign-in ke baad hi daam dikhata hai — order se pehle final card par poora total dikhega._"],
    [/^Okay, cancelled ✅ Nothing was ordered or paid\.( Tell me anytime if you'd like to order again\.)?$/gm, "Theek hai, cancel kar diya ✅ Kuch order nahi hua, koi paisa nahi gaya."],
    [/^Okay 👍 I won't look further\. Tell me whenever you want something\.$/gm, "Theek hai 👍 ab aur nahi dhoondhungi. Jab kuch chahiye, bata dijiye."],
    [/^(\w[\w ]*) didn't load for me just now 🙏 Want me to try \*([^*]+)\* instead\?$/gm, "$1 abhi khul nahi raha 🙏 *$2* par dekh loon?"],
    [/^(\w+) shows nothing matching "([^"]+)" near you\. Try another name\.$/gm, "$1 par \"$2\" aapke paas nahi mila 🙏 Koi aur naam bataiye?"],
    [/^(\w+): nothing matching right now\.$/gm, "$1: abhi kuch nahi mila."],
    [/Zepto blocks automated browsing, so I can't see its items or prices 🙏/g, "Zepto automatic browsing rok deta hai, isliye uske items ya daam nahi dekh sakti 🙏"],
    [/\(Zepto blocks automated browsing, so I can't include it\.\)/g, "(Zepto automatic browsing rok deta hai, isliye use shamil nahi kar sakti.)"],
];

export function isHindiLang(lang: string | null | undefined): boolean {
    return /^(hi|hinglish|hindi)/i.test(String(lang || ""));
}

export function localizeCanned(text: string, lang: string | null | undefined): string {
    if (!text || !isHindiLang(lang)) return text;
    let t = text;
    for (const [re, rep] of RULES) t = t.replace(re, rep);
    return t;
}
