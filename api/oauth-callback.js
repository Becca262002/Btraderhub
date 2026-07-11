// /api/oauth-callback — decrypts code_verifier from state token
import { createDecipheriv } from 'crypto';

const SECRET = process.env.PKCE_SECRET || "monehunt ai-pkce-secret-key-32chr!";
const KEY    = Buffer.from(SECRET.padEnd(32).slice(0,32));

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const { code, state } = await parseBody(req);
    if (!code || !state) return res.status(400).json({ error: 'Missing code or state' });

    const clientId = process.env.DERIV_CLIENT_ID || "33ByqD0GecGTE5whirko8";

    // Decrypt code_verifier from state token
    let code_verifier, redirectUri;
    try {
        const parts = state.split('.');
        if (parts.length < 2) throw new Error('Invalid state format');
        const token     = parts[1];
        const buf       = Buffer.from(token.replace(/-/g,'+').replace(/_/g,'/'), 'base64');
        const iv        = buf.slice(0, 12);
        const tag       = buf.slice(12, 28);
        const encrypted = buf.slice(28);
        const decipher  = createDecipheriv('aes-256-gcm', KEY, iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        const payload   = JSON.parse(decrypted.toString('utf8'));

        // Check expiry (10 minutes)
        if (Date.now() - payload.ts > 600000) {
            return res.status(400).json({ error: 'Session expired. Please log in again.' });
        }
        code_verifier = payload.cv;
        redirectUri   = payload.ru;
    } catch(err) {
        console.error('State decryption failed:', err.message);
        return res.status(400).json({ error: 'Invalid or expired session. Please log in again.' });
    }

    // Exchange code for tokens
    const body = new URLSearchParams();
    body.set('grant_type',    'authorization_code');
    body.set('client_id',     clientId);
    body.set('code',          code);
    body.set('code_verifier', code_verifier);
    body.set('redirect_uri',  redirectUri);

    try {
        const r    = await fetch('https://auth.deriv.com/oauth2/token', {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });
        const json = await r.json();
        if (!r.ok) return res.status(r.status).json({ error: json.error || 'Token exchange failed' });
        return res.status(200).json(json);
    } catch(err) {
        console.error('Token exchange error:', err);
        return res.status(500).json({ error: 'Server error. Please try again.' });
    }
}

async function parseBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}