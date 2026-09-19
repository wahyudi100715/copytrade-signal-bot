// functions/index.js
//
// Cloudflare Pages Function buat rute "/" (root situs). Kalau ada
// parameter ?ca=<alamat token> di URL, function ini manggil endpoint
// internal /api/scan (yang udah ada di functions/api/scan.js) buat
// ambil skor & verdict beneran, terus suntikkan ke meta tag OG/Twitter
// sebelum HTML dikirim ke browser.
//
// Ini jalan di edge (server), BUKAN di browser — makanya kebaca sama
// bot crawler X/Telegram/WhatsApp yang gak menjalankan JavaScript.
//
// Tanpa ?ca= di URL, function ini gak ngapa-ngapain — langsung serve
// index.html apa adanya kayak biasa.

export async function onRequest(context) {
  const { request, next } = context;

  // Cuma proses request GET buat halaman HTML. Method lain (kalau ada)
  // dan asset non-HTML lewat aja tanpa disentuh.
  if (request.method !== 'GET') {
    return next();
  }

  const url = new URL(request.url);
  const ca = url.searchParams.get('ca');

  if (!ca) {
    return next();
  }

  const response = await next();
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) {
    return response;
  }

  let html = await response.text();
  let scan = null;

  // Sama seperti og-image.js: cache hasil /api/scan per-token selama
  // 5 menit di edge, biar token yang di-share rame-rame gak nembak
  // DexScreener berkali-kali dalam waktu singkat.
  const cache = caches.default;
  const cacheKey = new Request(`https://tokenscansd-og-cache.internal/scan/${ca}`);

  try {
    const cachedRes = await cache.match(cacheKey);
    if (cachedRes) {
      scan = await cachedRes.json();
    } else {
      const scanRes = await fetch(
        `${url.origin}/api/scan?token=${encodeURIComponent(ca)}&lang=id`,
        { cf: { cacheTtl: 0, cacheEverything: false } }
      );
      if (scanRes.ok) {
        const data = await scanRes.json();
        // scan.js selalu balikin HTTP 200 walau gagal internal (biar gak
        // dianggap down sama health-check OKX), jadi kita cek field
        // `error` buat tau ini beneran hasil scan atau bukan.
        if (!data.error && data.symbol && data.symbol !== '???') {
          scan = data;
          const cacheResponse = new Response(JSON.stringify(data), {
            headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' },
          });
          context.waitUntil(cache.put(cacheKey, cacheResponse));
        }
      }
    }
  } catch (err) {
    // Endpoint /api/scan gagal ditembak (timeout dll) — gak masalah,
    // fallback ke teks generik di bawah, jangan bikin request ini gagal.
    scan = null;
  }

  const shareUrl = `${url.origin}${url.pathname}?ca=${encodeURIComponent(ca)}`;

  let title, description;

  if (scan) {
    const liquidity = scan.details && scan.details.liquidity_usd
      ? formatUsd(scan.details.liquidity_usd)
      : null;

    title = `Scan $${scan.symbol} (${scan.chain}) — Skor ${scan.score}/100 ${scan.verdict} | TokenScan SD`;

    const parts = [
      `Skor keamanan on-chain: ${scan.score}/100 (${scan.verdict}).`,
      scan.verdict_detail || '',
      liquidity ? `Liquidity: ${liquidity}.` : '',
      'Data on-chain, bukan saran investasi — selalu DYOR.',
    ].filter(Boolean);
    description = parts.join(' ');
  } else {
    title = 'TokenScan SD — Hasil Scan Token';
    description = 'Cek likuiditas, distribusi holder, dan tanda-tanda rug pull untuk token ini di TokenScan SD — gratis, dalam bahasa yang gampang dimengerti.';
  }

  const esc = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const escTitle = esc(title);
  const escDesc = esc(description);
  const escUrl = esc(shareUrl);
  const escImage = scan ? esc(`${url.origin}/og-image?ca=${encodeURIComponent(ca)}`) : null;

  html = html
    .replace(/<title>.*?<\/title>/is, `<title>${escTitle}</title>`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/i, `$1${escTitle}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/i, `$1${escDesc}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/i, `$1${escUrl}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/i, `$1${escTitle}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/i, `$1${escDesc}$2`);

  if (escImage) {
    html = html
      .replace(/(<meta property="og:image" content=")[^"]*(")/i, `$1${escImage}$2`)
      .replace(/(<meta name="twitter:image" content=")[^"]*(")/i, `$1${escImage}$2`);
  }

  const newResponse = new Response(html, response);
  newResponse.headers.set('content-type', 'text/html; charset=UTF-8');
  return newResponse;
}

function formatUsd(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  if (num >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `$${(num / 1e3).toFixed(1)}K`;
  return `$${num.toFixed(0)}`;
}
