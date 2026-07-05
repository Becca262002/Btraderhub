// /api/oauth-start — Server-side PKCE (Amy mobile-safe solution)
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const clientId    = process.env.DERIV_CLIENT_ID || "33ByqD0GecGTE5whirko8";
    const redirectUri = 'https://btraderhub.com/callback';

    function rand(n) {
        const a = new Uint8Array(n);
        crypto.getRandomValues(a);
        return a;
    }
    function base64url(buf) {
        return Buffer.from(buf).toString('base64')
            .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
    }

    const charset       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const code_verifier = Array.from(rand(64), b => charset[b % charset.length]).join('');
    const state         = base64url(rand(16));
    const digest        = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code_verifier));
    const code_challenge = base64url(new Uint8Array(digest));

    globalThis.__PKCE ||= new Map();
    const now = Date.now();
    for (const [k,v] of globalThis.__PKCE.entries()) {
        if (now - v.created_at > 600000) globalThis.__PKCE.delete(k);
    }
    globalThis.__PKCE.set(state, { code_verifier, redirect_uri: redirectUri, created_at: now });

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