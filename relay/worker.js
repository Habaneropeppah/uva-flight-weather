// UVA Flight Weather relay (Cloudflare Worker)
//
// The app can't read findu.com directly (http only, and no permission for other sites to read it),
// so this tiny relay fetches a station's latest weather reports from findu.com and hands them
// to the app as JSON. Only the stations listed in ALLOWED can be fetched, so it isn't an open proxy.
//
//   GET /station?call=EW9528  ->  { call, reports: [{ time, tempF, dir, mph, gust, rh, mb }, ...] }

const ALLOWED = ['EW9528'];          // add the Patriot Park station here if it ever goes up
const CACHE_SECONDS = 120;           // findu gets one request per station every 2 minutes at most

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (url.pathname !== '/station') return new Response('UVA Flight Weather relay', { headers: cors });

    const call = (url.searchParams.get('call') || '').toUpperCase();
    if (!ALLOWED.includes(call)) return json({ error: 'station not allowed' }, 400, cors);

    // Serve from Cloudflare's cache when we fetched this station recently
    const cache = caches.default;
    const key = new Request(`https://relay.cache/station/${call}`);
    const hit = await cache.match(key);
    if (hit) return withHeaders(hit, cors);

    let reports;
    try {
      const r = await fetch(`http://www.findu.com/cgi-bin/wx.cgi?call=${call}&last=3`, {
        headers: { 'User-Agent': 'UVA-Flight-Weather-relay (Utah Valley Aeromodelers club app)' },
      });
      if (!r.ok) throw new Error(`findu ${r.status}`);
      reports = parse(await r.text());
    } catch (e) {
      return json({ call, error: String(e.message || e), reports: [] }, 502, cors);
    }

    const res = json({ call, source: 'findu.com (CWOP / APRS)', fetched: new Date().toISOString(), reports }, 200,
      { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });
    ctx.waitUntil(cache.put(key, res.clone()));
    return withHeaders(res, cors);
  },
};

// findu's table rows: time (UTC, yyyymmddhhmmss), temp F, wind dir, speed mph, gust mph,
// rain 1hr, rain 24hr, rain since midnight, humidity %, barometer mb. Newest first.
function parse(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const re = /\b(\d{14})\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) && out.length < 6) {
    const t = m[1];
    out.push({
      time: `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}Z`,
      tempF: +m[2], dir: +m[3], mph: +m[4], gust: +m[5], rh: +m[9], mb: +m[10],
    });
  }
  return out;
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
function withHeaders(res, extra) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(extra)) r.headers.set(k, v);
  return r;
}
