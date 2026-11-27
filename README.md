# Muse Agent Desktop

Aplikasi agent AI desktop untuk Windows (Electron + Node), memakai **API key milik
sendiri**. Ini aplikasi pribadi — **bukan** aplikasi resmi Meta dan tidak terhubung
ke backend Muse/Meta mana pun.

Agent bisa mengobrol sekaligus benar-benar bekerja di folder workspace yang dipilih:
membaca, menulis, dan mengedit file, melihat isi folder, dan menjalankan perintah —
dengan semua pemanggilan tool tampil di layar dan tercatat di sesi.

## Provider

Empat provider, semuanya lewat protokol OpenAI-compatible yang sama. Tiap provider
punya field API key sendiri, dropdown model, dan kolom model kustom (teks bebas,
menimpa dropdown). Provider + model aktif selalu tampil di header.

| Provider | Endpoint | Model bawaan |
|---|---|---|
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-3.5-flash` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | `meta/llama-3.3-70b-instruct` |

Daftar model Gemini & NVIDIA NIM diambil dari katalog OpenTask yang sudah terbukti
(`Providers.java`): Gemini 3.5 Flash / 3.5 Flash-Lite / 2.5 Flash / 2.5 Pro /
2.5 Flash-Lite; Llama 3.3 70B, Qwen3 Coder 480B, Qwen2.5 Coder 32B, DeepSeek R1,
Nemotron 3 Super 120B, Nemotron Super 49B, Kimi K2, Llama 3.1 405B / 8B.
OpenAI: gpt-4o, gpt-4o-mini, gpt-4.1, gpt-4.1-mini.
OpenRouter: anthropic/claude-sonnet-4, openai/gpt-4o, google/gemini-2.5-pro,
deepseek/deepseek-chat.

**Cara mengisi key:** buka aplikasi → tombol **Settings** → tempel key pada kartu
provider-nya → tandai "Provider aktif" → Simpan. Key gratis Gemini ada di Google AI
Studio (aistudio.google.com/apikey); key gratis NVIDIA NIM ada di build.nvidia.com
(awalan `nvapi-`, tanpa kartu kredit).

Key disimpan lokal di `settings.json` pada folder userData aplikasi di komputer
ini, terenkripsi dengan keychain OS bila tersedia (Stage 6, lihat di bawah) —
tidak pernah dikirim ke mana pun selain endpoint provider-nya sendiri.

## Menjalankan secara lokal

Butuh Node.js 20+.

```bash
npm install
npm start        # membuka aplikasi (Electron)
npm test         # uji unit Node (providers, tools, sessions)
```

## Membuat .exe Windows

Cara yang disarankan: **GitHub Actions**. Push repo ini ke GitHub, lalu workflow
`.github/workflows/build-windows.yml` berjalan di `windows-latest`
(checkout → setup-node 20 → npm install → npm test → `electron-builder --win`)
dan mengunggah hasilnya sebagai artifact `muse-agent-desktop-windows`:
satu installer NSIS dan satu portable `.exe` (target diatur di `package.json`,
appId `id.kangris.museagent`, productName "Muse Agent Desktop").
Workflow juga bisa dijalankan manual dari tab Actions (workflow_dispatch).

Build lokal di mesin Windows juga bisa: `npm run dist`.

> Catatan jujur: aplikasi ini dikembangkan dan diuji unit di Linux. Uji GUI dan
> .exe final terjadi di Windows lewat GitHub Actions — belum ada klaim GUI teruji
> sebelum artifact Actions pertama benar-benar dijalankan dan dibuka di Windows.

## Cara kerja

- **Tools agent** (semua dibatasi di dalam folder workspace yang dipilih):
  `read_file`, `write_file`, `edit_file`, `list_dir`, dan `run_command`
  (cwd = workspace, timeout 60 detik, output dipotong). Tool file menolak path
  yang keluar dari workspace. `run_command` menjalankan perintah shell dengan
  cwd workspace — perlakukan seperti terminal biasa, jangan beri perintah yang
  tidak kamu pahami.
- **Sesi**: setiap sesi dicatat sebagai JSONL (satu baris per pesan / tool-call /
  tool-result, lengkap dengan timestamp ISO, cwd workspace, provider, dan model)
  di dua tempat: folder userData aplikasi dan cermin di
  `<workspace>/.agent-sessions/<session-id>.jsonl`. Sesi lama bisa dilanjutkan
  dari daftar di sidebar. Formatnya mengikuti gaya Claude Code JSONL sebisa
  mungkin — **eksperimental**: belum terbukti lolos cek server make.fun.
- **Keamanan renderer**: `contextIsolation: true`, `nodeIntegration: false`;
  renderer hanya bisa bicara ke proses utama lewat jembatan preload (`window.api`).

## Mode make.fun (v1)

Toggle **Mode make.fun** di header menyuntikkan isi rules make.fun
(`~/workspace/makefun-agent-rules/.clinerules` bila ada; jika tidak, salinan
bawaan di `assets/makefun-rules.txt`) ke system prompt, dan mengingatkan untuk
memilih folder repo bounty sebagai workspace. Selebihnya v1 memang disengaja
terbatas sampai di sini.

## Pipeline make.fun (Stage 2)

Tombol **make.fun** di header membuka panel pipeline untuk workspace aktif:

1. **Bundle** — memilih sesi terekam dari `.agent-sessions` workspace,
   mengekstrak system prompt-nya verbatim dari rekaman (untuk
   `--system-prompt`) dan prompt user pertamanya (untuk `--prompt-file`,
   `--prompt-origin typed`), lalu menjalankan `bundle` CLI kit dengan
   deklarasi `--harness claude-code --harness-version 2.1.0` dan vendor
   yang dipetakan dari provider sesi (gemini → google, openrouter →
   awalan vendor model, nvidia → vendor dari id model). Hasilnya
   `.makefun-bundle.tar.gz` di workspace.
2. **Check** — menjalankan `check` CLI kit atas bundle itu pada commit
   HEAD workspace dan menampilkan ringkasan terstruktur (passed / failed
   / skipped / at submission + nama cek yang gagal).
3. **Submit** — mengirim bundle dengan keypair agent (path diatur di
   panel, default `~/.makefun/makefun-keypair.json`; isinya tidak pernah
   dibaca aplikasi). Tombolnya dua langkah: klik pertama hanya
   mengaktifkan status konfirmasi, klik kedua yang benar-benar submit.

Log CLI tampil langsung (streaming) di panel. Format rekaman sesi
(Stage 1b) sudah lolos semua gerbang transkrip pada bukti headless;
jalur submit sendiri belum pernah dijalankan dari aplikasi ini.

## Bounty Baru + kunci workspace (Stage 3)

- **Wizard "✦ Bounty Baru"** (tombol di header) membuat folder proyek
  bounty baru — satu folder = satu bounty = satu sesi — berisi
  `.clinerules` (disalin byte-identical dari
  `~/workspace/makefun-agent-rules/.clinerules`), LICENSE MIT dengan
  baris SPDX, `.makefun/owner.json` berisi wallet agent publik, dan
  scaffold README standar visual (placeholder badge ditandai jelas —
  badge live spesifik kompetisi diisi dari requirements kit saat
  build). Folder ditolak bila sudah ada dan tidak kosong. Repo git
  diinisialisasi dengan satu commit awal, lalu workspace aplikasi
  langsung berpindah ke folder baru.
- **Kunci workspace keras** di lapisan tool: setiap path tool file
  dinormalisasi DAN diresolusi symlink (leluhur terdalam yang ada), dan
  ditolak bila keluar dari root workspace — lewat `..`, path absolut,
  maupun symlink. `run_command` berjalan dengan cwd = root workspace;
  cwd yang diminta di luar workspace ditolak. Tidak ada bypass.

## Panel sesi & biaya (Stage 4)

- **Modul `src/usage.js`** (murni, tanpa I/O) membaca usage dari rekaman
  sesi — bentuk sekarang (`message.usage`) maupun v1 (`usage` level atas
  bentuk OpenAI) — dan merangkum per sesi: token masuk/keluar, token
  cache, jumlah pesan user, turn asisten, tool call/result, durasi,
  rincian per model, dan tabel per turn.
- **Estimasi biaya** dari tabel harga publik per 1 jt token di modul
  yang sama (Gemini, OpenAI, OpenRouter; model NVIDIA NIM hosted
  tercatat $0 karena endpoint dev-nya gratis). Ini **estimasi, bukan
  tagihan**: tier gratis/kredit/perubahan harga tidak tercermin. Model
  yang tidak ada di tabel dilaporkan sebagai *belum terharga*
  (tokennya dihitung terpisah), tidak pernah dipalsukan jadi $0.
- **Panel "📊 Sesi & Biaya"** di header menampilkan kartu total semua
  sesi (token, estimasi, jumlah sesi), rincian sesi yang sedang aktif
  beserta tabel per turn-nya, dan daftar semua sesi dengan total
  masing-masing — klik satu sesi di daftar untuk membukanya. Item sesi
  di sidebar kini juga menampilkan total token + estimasi biayanya.
- IPC baru: `session:usage` (satu sesi) dan `session:usageOverview`
  (agregat + semua sesi), lewat jembatan preload `getSessionUsage` /
  `getUsageOverview`.

## Git bawaan + panel turnamen kandidat (Stage 5)

- **Panel "⎇ Git"** (`src/git.js`): status repo workspace aktif
  (branch, upstream, ahead/behind, daftar staged / berubah / belum
  terlacak), statistik diff, dan 20 commit terakhir. Satu-satunya
  operasi tulis yang disengaja sempit: tombol **Commit Semua
  Perubahan** menjalankan `git add -A` + commit dengan pesanmu di
  dalam workspace. Tidak ada push, ganti branch, atau ubah riwayat
  dari aplikasi — push tetap tindakan sadar di luar aplikasi.
- **Panel "🏆 Turnamen"** (`src/tournament.js`): alur yang dipakai
  untuk bounty teks yang dinilai juri — hasilkan 3–20 kandidat yang
  benar-benar berbeda untuk satu brief + kriteria lewat provider
  aktif (satu panggilan, output JSON array; parser toleran terhadap
  daftar bernomor dan pemisah `---` bila model meleset), beri bintang
  1–5, buang kandidat lemah, tetapkan satu pemenang. Ranking: pemenang
  > berbintang (seri → yang lebih pendek menang) > belum dinilai >
  terbuang. Turnamen tersimpan sebagai JSON di `<workspace>/.tournament/`
  dan pemenang diekspor ke `<workspace>/TOURNAMENT-WINNER.md`.
- IPC baru: `git:info`, `git:commit`, `tournament:generate`,
  `tournament:list`, `tournament:load`, `tournament:save`.

## Enkripsi API key (Stage 6)

- **`src/secrets.js`** membungkus cipher Electron `safeStorage`
  (Windows DPAPI / keychain OS) dengan format disk `enc:v1:<base64>`
  pada field `apiKey` yang sama di `settings.json`. Hanya API key
  yang dienkripsi — model, workspace, path, dan alamat wallet publik
  tidak pernah disentuh.
- **Migrasi transparan:** file settings lama (plaintext) terbaca
  seperti biasa, dan otomatis terenkripsi pada penyimpanan
  berikutnya. Di memori aplikasi key selalu plaintext; yang terenkripsi
  hanya yang tertulis di disk.
- **Fallback jujur:** bila keychain OS tidak tersedia (mis. Linux
  tanpa keyring), format lama plaintext dipakai dan aplikasi tetap
  berjalan — statusnya dicatat di log proses utama saat start.
- **File asing/rusak aman:** nilai terenkripsi yang tidak bisa dibuka
  di mesin ini (file disalin dari komputer/user lain, keychain
  berubah) terbaca sebagai key kosong — user cukup memasukkan ulang
  key-nya; cipher text tidak pernah bocor menjadi "key" yang terkirim
  ke provider.

## Mode izin tool (Stage 7)

- **`src/permissions.js`** — gerbang izin murni. Tool baca
  (`read_file`, `list_dir`) tidak pernah ditanya. Tool pengubah
  (`write_file`, `edit_file`, `run_command`) mengikuti
  `settings.permissions.mode`: **`tanya`** (default — kartu
  persetujuan muncul di chat sebelum tool jalan) atau **`bebas`**
  (perilaku lama, tanpa tanya).
- **Pilihan jawaban pada kartu:** *Izinkan sekali* · *Izinkan sesi
  ini* (berlaku sampai sesi/workspace berganti) · *Selalu izinkan
  tool ini* (tersimpan di `settings.permissions.alwaysTools`) ·
  *Tolak*.
- **Penolakan aman:** tool yang ditolak tidak pernah dieksekusi;
  model menerima hasil tool "DITOLAK oleh user" agar bisa
  menyesuaikan. Prompt yang tidak dijawab dalam 5 menit otomatis
  ditolak, dan tombol Stop menolak semua prompt yang menggantung.
- Loop agent berkonsultasi lewat callback `approveTool` yang
  diinjeksikan proses utama; tanpa callback (mis. pada test) semua
  tool berjalan seperti sebelumnya.

## Roadmap v2

- Mesin OpenCode terintegrasi sebagai jalur agent alternatif yang transkripnya
  sudah terbukti diterima make.fun.
- Membuktikan format sesi JSONL aplikasi ini terhadap cek server make.fun
  lewat satu entry sungguhan sebelum dipakai rutin.

## Struktur

```
main.js                 proses utama Electron + IPC
preload.js              jembatan aman renderer <-> main
src/providers.js        katalog 4 provider + klien chat-completions
src/tools.js            5 tool agent, terkurung di workspace
src/sessions.js         perekaman sesi JSONL (+ cermin ke workspace)
src/agent.js            agent loop (tool calling)
src/store.js            settings.json di userData
src/makefun.js          pipeline make.fun (bundle/check/submit via CLI kit)
src/wizard.js           wizard "Bounty Baru" (scaffold proyek + git init)
src/usage.js            ringkasan usage token + estimasi biaya per sesi (Stage 4)
src/git.js              git bawaan: status/log/diff/commit di workspace (Stage 5)
src/tournament.js       turnamen kandidat: prompt/parse/ranking/penyimpanan (Stage 5)
src/secrets.js          enkripsi API key di disk via safeStorage OS (Stage 6)
src/permissions.js      gerbang izin tool: mode tanya/bebas + grant sesi & permanen (Stage 7)
renderer/               UI chat murni HTML/CSS/JS (tema charcoal + gold)
assets/makefun-rules.txt  salinan rules make.fun untuk Mode make.fun
test/                   uji unit Node
```
