import { randomUUID } from "crypto";
import type {
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { encryptJson, decryptJson } from "../../utils/tokenVault.util";

type ProviderOpts = {
    redirectUri: string;
    oauthState: string;
    codeVerifier?: string;
    tokens?: OAuthTokens;
    clientInformation?: OAuthClientInformationMixed;
    onAuthorizationUrl?: (url: string) => void;
    onCodeVerifier?: (verifier: string) => void;
    onTokens?: (tokens: OAuthTokens) => void;
    onClientInfo?: (info: OAuthClientInformationMixed) => void;
};

export class KavachMcpOAuthProvider implements OAuthClientProvider {
    private _codeVerifier?: string;
    private _tokens?: OAuthTokens;
    private _clientInformation?: OAuthClientInformationMixed;
    private readonly oauthState: string;
    private readonly redirectUri: string;

    constructor(private readonly opts: ProviderOpts) {
        this.oauthState = opts.oauthState;
        this.redirectUri = opts.redirectUri;
        this._codeVerifier = opts.codeVerifier;
        this._tokens = opts.tokens;
        this._clientInformation = opts.clientInformation;
    }

    get redirectUrl(): string {
        return this.redirectUri;
    }

    get clientMetadata(): OAuthClientMetadata {
        return {
            client_name: "Kavach Care Dashboard",
            redirect_uris: [this.redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
        };
    }

    state(): string {
        return this.oauthState;
    }

    clientInformation(): OAuthClientInformationMixed | undefined {
        return this._clientInformation;
    }

    async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
        this._clientInformation = info;
        this.opts.onClientInfo?.(info);
    }

    tokens(): OAuthTokens | undefined {
        return this._tokens;
    }

    async saveTokens(tokens: OAuthTokens): Promise<void> {
        this._tokens = tokens;
        this.opts.onTokens?.(tokens);
    }

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
        this.opts.onAuthorizationUrl?.(authorizationUrl.toString());
    }

    async saveCodeVerifier(codeVerifier: string): Promise<void> {
        this._codeVerifier = codeVerifier;
        this.opts.onCodeVerifier?.(codeVerifier);
    }

    async codeVerifier(): Promise<string> {
        if (!this._codeVerifier) throw new Error("PKCE code verifier missing");
        return this._codeVerifier;
    }
}

export function createOAuthState(): string {
    return randomUUID().replace(/-/g, "");
}

export function sealOAuthSession(data: {
    codeVerifier: string;
    clientInformation?: OAuthClientInformationMixed;
}) {
    return {
        codeVerifierEnc: encryptJson({ codeVerifier: data.codeVerifier }),
        clientInfoEnc: data.clientInformation
            ? encryptJson(data.clientInformation)
            : undefined,
    };
}

export function unsealCodeVerifier(codeVerifierEnc: string): string {
    return decryptJson<{ codeVerifier: string }>(codeVerifierEnc).codeVerifier;
}

export function unsealClientInfo(clientInfoEnc: string): OAuthClientInformationMixed {
    return decryptJson<OAuthClientInformationMixed>(clientInfoEnc);
}
