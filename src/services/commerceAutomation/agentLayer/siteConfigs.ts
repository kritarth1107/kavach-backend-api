/**
 * Per-site step goals for the agent layer. Deterministic code runs first where it exists
 * (Apollo has a full deterministic checkout); these natural-language goals are what the
 * Stagehand fallback observes against when code can't find its target.
 *
 * NOTE: food/grocery goals are best-effort and have NOT been verified end-to-end against
 * live signed-in accounts (no test accounts). Guardrails apply regardless.
 */
import type { AllowedOrderSite } from "../siteAllowlist";

export type CheckoutStepKey = "open_cart" | "proceed_checkout" | "select_address" | "dismiss_upsell" | "reach_payment";

export type SiteConfig = {
    key: AllowedOrderSite;
    label: string;
    /** Page that shows the cart / bill (null → open via the cart button). */
    cartUrl: string | null;
    kind: "pharmacy" | "grocery" | "food" | "ride";
    goals: Record<CheckoutStepKey, string>;
    /** Words that identify the COD option on this site. */
    codLabels: string[];
};

const common: Record<CheckoutStepKey, string> = {
    open_cart: "Open the shopping cart / bag so the cart items and bill are visible (the cart icon or 'View cart' button).",
    proceed_checkout:
        "Click the button that continues from the cart to checkout (e.g. 'Proceed', 'Checkout', 'Continue', 'Select address').",
    select_address:
        "Continue with the already-selected / default saved delivery address (e.g. 'Deliver here', 'Confirm address', 'Continue').",
    dismiss_upsell:
        "Close or skip any popup, drawer or banner that offers a membership, plan, subscription, offer or coupon (the close ✕, 'Skip', 'No thanks', 'Maybe later').",
    reach_payment:
        "Continue to the screen where the payment method is chosen (e.g. 'Proceed to payment', 'Continue', 'Choose payment method'). Do not choose any payment method.",
};

export const SITE_CONFIGS: Record<AllowedOrderSite, SiteConfig> = {
    apollo: {
        key: "apollo",
        label: "Apollo Pharmacy",
        cartUrl: "https://www.apollopharmacy.in/medicines-cart",
        kind: "pharmacy",
        goals: {
            ...common,
            proceed_checkout: "Click the 'Proceed' / 'Proceed to checkout' button on the Apollo cart.",
            select_address: "Continue with the selected delivery address ('Proceed' in the 'Deliver to' popup, or 'Continue').",
        },
        codLabels: ["Cash on Delivery", "COD"],
    },
    pharmeasy: {
        key: "pharmeasy",
        label: "PharmEasy",
        cartUrl: "https://pharmeasy.in/cart",
        kind: "pharmacy",
        goals: { ...common, proceed_checkout: "Click 'Continue' / 'Proceed' on the PharmEasy cart." },
        codLabels: ["Cash on Delivery", "Pay on Delivery", "COD"],
    },
    instamart: {
        key: "instamart",
        label: "Swiggy Instamart",
        cartUrl: "https://www.swiggy.com/instamart/cart",
        kind: "grocery",
        goals: { ...common },
        codLabels: ["Pay on Delivery", "Cash on Delivery", "Cash/UPI on delivery"],
    },
    swiggy: {
        key: "swiggy",
        label: "Swiggy",
        cartUrl: "https://www.swiggy.com/checkout",
        kind: "food",
        goals: { ...common },
        codLabels: ["Pay on Delivery", "Cash on Delivery", "Cash/UPI on delivery"],
    },
    zepto: {
        key: "zepto",
        label: "Zepto",
        cartUrl: null,
        kind: "grocery",
        goals: { ...common },
        codLabels: ["Cash on Delivery", "Pay on Delivery", "Cash/UPI on delivery"],
    },
    blinkit: {
        key: "blinkit",
        label: "Blinkit",
        cartUrl: null,
        kind: "grocery",
        goals: { ...common, proceed_checkout: "Click 'Proceed' / 'Proceed to pay' at the bottom of the Blinkit cart drawer." },
        codLabels: ["Cash on Delivery", "Pay on Delivery", "Cash"],
    },
    zomato: {
        key: "zomato",
        label: "Zomato",
        cartUrl: null,
        kind: "food",
        goals: { ...common },
        codLabels: ["Cash on Delivery", "Pay on Delivery", "Cash"],
    },
    uber: {
        key: "uber",
        label: "Uber",
        cartUrl: null,
        kind: "ride",
        goals: {
            open_cart: "Show the ride options for the entered pickup and drop.",
            proceed_checkout: "Select the cheapest standard ride option (do not request it).",
            select_address: "Confirm the pickup location on the map (do not request the ride).",
            dismiss_upsell: common.dismiss_upsell,
            reach_payment: "Show the payment method currently selected (do not change it).",
        },
        codLabels: ["Cash"],
    },
};

export function siteConfig(partner: string | null | undefined): SiteConfig | null {
    if (!partner) return null;
    return (SITE_CONFIGS as Record<string, SiteConfig>)[partner] ?? null;
}
