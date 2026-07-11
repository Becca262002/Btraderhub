// /api/oauth-start — PKCE encoded in state (no shared storage needed)
import { createCipheriv, randomBytes } from 'crypto';

const SECRET = process.env.PKCE_SECRET || "monehunt ai-pkce-secret-key-32chr!";
const KEY    = Buffer.from(SECRET.padEnd(32).slice(0,32));

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const clientId    = process.env.DERIV_CLIENT_ID || "33ByqD0GecGTE5whirko8";
    const redirectUri = 'https://monehunt ai.com/callback';

    function base64url(buf) {
        return Buffer.from(buf).toString('base64')
            .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
    }

    // Generate PKCE
    const charset       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const cvBytes       = randomBytes(64);
    const code_verifier = Array.from(cvBytes, b => charset[b % charset.length]).join('');
    const stateRaw      = base64url(randomBytes(16));

    const hashBuf       = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code_verifier));
    const code_challenge = base64url(new Uint8Array(hashBuf));

    // Encrypt code_verifier and store in state token
    // state = stateRaw + "." + encrypted(code_verifier + "|" + redirectUri)
    const iv         = randomBytes(12);
    const cipher     = createCipheriv('aes-256-gcm', KEY, iv);
    const payload    = Buffer.from(JSON.stringify({ cv: code_verifier, ru: redirectUri, ts: Date.now() }));
    const encrypted  = Buffer.concat([cipher.update(payload), cipher.final()]);
    const tag        = cipher.getAuthTag();
    const token      = base64url(Buffer.concat([iv, tag, encrypted]));
    const state      = stateRaw + '.' + token;

    return res.status(200).json({
        authorization_endpoint: 'https://auth.deriv.com/oauth2/auth',
        client_id:              clientId,
        redirect_uri:           redirectUri,
        state,
        code_challenge,
        code_challenge_method:  'S256',
        scope:                  'trade'
    });
}