/**
 * Instinct-parity commerce automation foundation.
 * Partners may implement via official MCP, OAuth, or browser/OTP session workers.
 */

/** MCP + browser site keys. Freeform shops use "generic" / "generic_grocery" playbooks. */
export type CommercePartnerKey =
    | "swiggy"
    | "instamart"
    | "zepto"
    | "blinkit"
    | "zomato"
    | "apollo"
    | "pharmeasy"
    | "tata_1mg"
    | "bigbasket"
    | "jiomart"
    | "dmart"
    | "natures_basket"
    | "amazon"
    | "flipkart"
    | "myntra"
    | "generic_grocery";

export type AutomationSessionStatus =
    | "disconnected"
    | "pending_login"
    | "awaiting_otp"
    | "connected"
    | "expired"
    | "error";

export type StoredPartnerSession = {
    userId: string;
    partner: CommercePartnerKey;
    status: AutomationSessionStatus;
    /** AES-GCM ciphertext of cookies/tokens — never log plaintext. */
    encryptedBlob?: string;
    otpChallengeId?: string;
    lastError?: string;
    updatedAt: Date;
    connectedAt?: Date;
};

export type SearchHit = {
    id: string;
    name: string;
    pricePaise?: number;
    requiresRx?: boolean;
    substitutionOf?: string;
};

export type BillSnapshot = {
    itemSubtotalPaise: number;
    feesPaise: number;
    smallOrderFeePaise?: number;
    grandTotalPaise: number;
    etaMinutes?: number;
    trackingUrl?: string;
};

export type PlaceResult = {
    ok: boolean;
    partnerOrderId?: string;
    status: "placed" | "needs_payment" | "error";
    etaMinutes?: number;
    trackingUrl?: string;
    message: string;
};

/**
 * Uniform adapter surface — MCP path or Playwright worker both satisfy this.
 */
export interface CommerceAutomationAdapter {
    partner: CommercePartnerKey;
    loginWithOtp(input: {
        userId: string;
        familyId: string;
        phoneE164: string;
    }): Promise<{ status: AutomationSessionStatus; otpChallengeId?: string; oauthUrl?: string }>;
    submitOtp(input: {
        userId: string;
        familyId: string;
        otp: string;
        otpChallengeId?: string;
    }): Promise<{ status: AutomationSessionStatus }>;
    search(input: {
        userId: string;
        familyId: string;
        query: string;
        addressId?: string;
    }): Promise<{ hits: SearchHit[]; message?: string }>;
    setAddress(input: {
        userId: string;
        familyId: string;
        addressId: string;
    }): Promise<{ ok: boolean }>;
    addToCart(input: {
        userId: string;
        familyId: string;
        itemId: string;
        quantity: number;
    }): Promise<{ ok: boolean; message?: string }>;
    getBill(input: {
        userId: string;
        familyId: string;
    }): Promise<BillSnapshot | null>;
    place(input: {
        userId: string;
        familyId: string;
        paymentMethod?: "COD" | "UPI";
    }): Promise<PlaceResult>;
}
