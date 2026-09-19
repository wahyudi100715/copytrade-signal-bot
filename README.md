# TSD Holder Snapshot Worker (Fase 2)

Cron + on-demand worker yang snapshot holder count + top-10 concentration,
simpan ke KV, dan hitung growth rate untuk Momentum Score.

**Watchlist-nya dinamis** — setiap kali ada yang scan token di TokenScanSD,
frontend manggil `POST /snapshot`, dan token itu otomatis kedaftar buat
di-snapshot ulang tiap 6 jam oleh cron. Tidak perlu isi array manual.

## Setup (dari Termux)

1. Copy folder ini jadi repo/worker baru (pola sama seperti
   `tokenscansd-trending-bot` yang sudah ada).

2. Buat KV namespace:
   ```
   npx wrangler kv namespace create TSD_MOMENTUM_KV
   ```
   Salin `id` yang muncul ke `wrangler.toml`.

3. Set secrets (boleh reuse key yang sudah dipakai di TokenScanSD3 utama):
   ```
   npx wrangler secret put HELIUS_API_KEY
   npx wrangler secret put ETHERSCAN_V2_API_KEY
   ```

4. Deploy:
   ```
   npx wrangler deploy
   ```

5. Catat subdomain hasil deploy (misal `tsd-holder-snapshot.wahyudiboy704.workers.dev`)
   dan pastikan cocok dengan `TSD_MOMENTUM_ENDPOINT` di `index.html` TokenScanSD3
   (cari baris `const TSD_MOMENTUM_ENDPOINT = ...`).

6. Test manual:
   ```
   curl -X POST https://tsd-holder-snapshot.<subdomain>.workers.dev/snapshot \
     -H "Content-Type: application/json" \
     -d '{"address":"<contract address>","chain":"solana"}'
   ```
   Chain yang didukung: `solana`, `eth`/`ethereum`, `bsc`, `base`, `arbitrum`.

7. Setelah minimal 2 snapshot terkumpul (bisa panggil /snapshot dua kali
   dengan jeda, atau tunggu satu siklus cron ~6 jam):
   ```
   curl "https://tsd-holder-snapshot.<subdomain>.workers.dev/growth?address=<addr>&chain=solana"
   ```

## Endpoint

- `POST /snapshot { address, chain }` — ambil snapshot sekarang + daftarkan
  token ke watchlist dinamis (dipanggil otomatis oleh frontend tiap scan)
- `GET /growth?address=&chain=` — hitung growth rate dari snapshot tertua
  vs terbaru yang tersimpan (khusus token itu)
- `POST /run` — jalankan satu siklus cron sekarang juga (semua token di
  watchlist), buat testing tanpa nunggu jadwal

## Catatan penting

- **CORS sudah diaktifkan** (`Access-Control-Allow-Origin: *`) supaya bisa
  dipanggil langsung dari browser di tokenscansd3.xyz.
- **Helius endpoint**: kode ini pakai `/v0/token-holders` sebagai contoh —
  sesuaikan dengan method/plan Helius yang sudah dipakai di TokenScanSD3
  utama kalau berbeda (misal DAS API).
- **Etherscan V2**: `tokenholderlist` kadang butuh plan berbayar tergantung
  chain — cek quota API key sebelum watchlist membesar.
- **Watchlist cap**: dibatasi 500 token (`MAX_WATCHLIST_SIZE`), entri
  terlama otomatis didrop kalau penuh — cukup buat mulai, naikkan kalau
  traffic scan sudah tinggi.
- **Retention snapshot**: 14 hari (`SNAPSHOT_RETENTION_DAYS`), sesuaikan
  kalau perlu histori lebih panjang.
- Fase 1 (volume acceleration, buy/sell pressure) sudah terpasang langsung
  di `index.html` tanpa perlu worker ini — worker ini khusus Fase 2.
- Fase 3 (social momentum) reuse endpoint `/api/social-signal` (LunarCrush)
  yang sudah ada di TokenScanSD3 — tidak perlu integrasi baru.
