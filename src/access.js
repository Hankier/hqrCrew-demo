// Cloudflare Access: verify the signed JWT Access adds to every request (Cf-Access-Jwt-Assertion),
// against the team's public keys and the application's audience tag. A plain email header could be
// forged by any process on the box; this signature can't.
import crypto from 'node:crypto';

let cache = { team: null, at: 0, keys: [] };

async function keys(team, { refresh = false } = {}) {
  if (!refresh && cache.team === team && Date.now() - cache.at < 3600e3) return cache.keys;
  const r = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Access certs: HTTP ${r.status}`);
  const j = await r.json();
  cache = { team, at: Date.now(), keys: j.keys || [] };
  return cache.keys;
}

function decode(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

// Returns the token's claims (email, aud, exp…) or throws.
export async function verifyAccessJwt(token, { team, aud, now = Date.now(), keySet } = {}) {
  if (!token || typeof token !== 'string') throw new Error('no Access token');
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) throw new Error('malformed token');
  const header = decode(h);
  const claims = decode(p);
  if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`);
  let list = keySet || (await keys(team));
  let jwk = list.find((k) => k.kid === header.kid);
  if (!jwk && !keySet) {
    list = await keys(team, { refresh: true });
    jwk = list.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error('unknown signing key');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'));
  if (!ok) throw new Error('bad signature');
  if (![].concat(claims.aud).includes(aud)) throw new Error('wrong audience');
  if (!claims.exp || claims.exp * 1000 < now) throw new Error('expired');
  if (claims.nbf && claims.nbf * 1000 > now + 60e3) throw new Error('not yet valid');
  if (team && claims.iss && claims.iss !== `https://${team}.cloudflareaccess.com`) throw new Error('wrong issuer');
  return claims;
}
