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
ini — tidak pernah dikirim ke mana pun selain endpoint provider-nya sendiri.

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
renderer/               UI chat murni HTML/CSS/JS (tema charcoal + gold)
assets/makefun-rules.txt  salinan rules make.fun untuk Mode make.fun
test/                   uji unit Node
```
