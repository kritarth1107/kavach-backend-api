/**
 * Token Blacklist Utility - In-memory implementation (Redis removed)
 * Note: In production, use a persistent store for blacklisted tokens.
 */
export class TokenBlacklist {
    private static blacklist = new Set<string>();

    /**
     * Blacklists a token.
     * @param token The raw active JWT string
     * @param _expiresInSeconds Not used in this in-memory implementation
     */
    public static async blacklistToken(
        token: string,
        _expiresInSeconds: number,
    ): Promise<void> {
        this.blacklist.add(token);
    }

    /**
     * Checks if a token is blacklisted.
     */
    public static async isBlacklisted(token: string): Promise<boolean> {
        return this.blacklist.has(token);
    }
}

export default TokenBlacklist;
