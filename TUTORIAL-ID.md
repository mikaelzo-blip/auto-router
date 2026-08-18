# Tutorial AutoRouter (Bahasa Indonesia)

Panduan ini menjelaskan cara menjalankan dan memakai AutoRouter sebagai router semantik di depan 9Router.

## 1. Arsitektur singkat

```text
Open WebUI / OpenCode / n8n / client lain
                |
                v
        AutoRouter :20200
                |
                v
          9Router :20128
                |
                v
      GPT / Gemini / model gratis
```

AutoRouter menerima request OpenAI-compatible. Jika client memakai model virtual `auto`, AutoRouter menentukan route berdasarkan isi prompt lalu mengganti `model` dengan model upstream yang sesuai.

## 2. Persyaratan

- Ubuntu 24.04 atau WSL2
- Node.js 24+
- 9Router aktif di `http://127.0.0.1:20128/v1`
- API key 9Router disimpan di environment lokal, **jangan commit API key ke Git**

## 3. Instalasi

```bash
cd ~/projects/auto-router
./scripts/setup.sh
cp .env.example .env
```

Isi `.env` hanya di komputer lokal jika upstream membutuhkan API key:

```env
UPSTREAM_API_KEY=ISI_KEY_LOKAL_DI_SINI
```

File `.env` sudah di-ignore oleh Git. Jangan menaruh key asli di `.env.example`, README, source code, test, atau commit.

## 4. Menjalankan AutoRouter

```bash
cd ~/projects/auto-router
./scripts/start.sh
```

AutoRouter mendengarkan hanya di:

```text
http://127.0.0.1:20200
```

Cek kesehatan service:

```bash
curl -s http://127.0.0.1:20200/health
```

Cek daftar virtual model:

```bash
curl -s http://127.0.0.1:20200/v1/models | python3 -m json.tool
```

## 5. Virtual model yang tersedia

Konfigurasi default menyediakan:

| Model virtual | Fungsi |
|---|---|
| `auto` | Default. AutoRouter memilih route berdasarkan prompt |
| `code` | Memaksa route coding/debugging/repository |
| `analysis` | Memaksa analisis dokumen, keuangan, kontrak, audit |
| `fast` | Chat sederhana, terjemahan, rewrite, penjelasan singkat |
| `explore` | Eksplorasi codebase/read-search tools |
| `research` | Informasi terbaru dan web research |

Untuk penggunaan umum, pilih **`auto`**.

## 6. Tes chat langsung dengan curl

```bash
curl -sS http://127.0.0.1:20200/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"auto",
    "messages":[
      {"role":"user","content":"jelaskan apa bedanya omzet dan laba"}
    ],
    "stream":false
  }' | python3 -m json.tool
```

Contoh coding:

```bash
curl -sS http://127.0.0.1:20200/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"auto",
    "messages":[
      {"role":"user","content":"tolong perbaiki error TypeScript ini"}
    ],
    "stream":false
  }' | python3 -m json.tool
```

## 7. Melihat route tanpa memanggil model

Endpoint `/debug/route` berguna untuk melihat keputusan router tanpa menghabiskan quota model.

```bash
curl -s http://127.0.0.1:20200/debug/route \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"auto",
    "messages":[
      {"role":"user","content":"analisis laporan keuangan perusahaan ini"}
    ]
  }' | python3 -m json.tool
```

Contoh prompt lain yang bisa dicoba:

```text
apa itu EBITDA?
perbaiki error TypeScript ini
cari berita AI terbaru hari ini
analisis laporan keuangan ini
bandingkan dua arsitektur API ini secara mendalam
```

## 8. Menggunakan dengan Open WebUI

Jika Open WebUI berjalan di Docker pada komputer yang sama, gunakan OpenAI-compatible connection:

```text
Base URL : http://host.docker.internal:20200/v1
Model    : auto
API Key  : placeholder jika UI mewajibkan key
```

AutoRouter sendiri tidak mengautentikasi caller lokal. API key upstream tetap dibaca dari environment AutoRouter dan tidak perlu diberikan ke Open WebUI.

Untuk chat sehari-hari:

```text
Open WebUI -> model auto
```

Untuk informasi terbaru, aktifkan fitur Web Search di Open WebUI lalu tetap gunakan `auto` atau `research` sesuai kebutuhan.

## 9. Menggunakan dengan OpenCode

Jika provider `autorouter` sudah dikonfigurasi di OpenCode dengan base URL:

```text
http://127.0.0.1:20200/v1
```

maka contoh penggunaan:

```bash
cd ~/projects/project-kamu
opencode
```

Atau langsung:

```bash
opencode run -m autorouter/auto "audit project ini dan cari bug paling penting"
```

Untuk memaksa route coding:

```bash
opencode run -m autorouter/code "perbaiki error TypeScript dan jalankan test"
```

Gunakan OpenCode ketika AI perlu membaca repository, mengubah file, menjalankan test/build, atau bekerja dengan Git.

## 10. Menggunakan dengan n8n

Jika n8n berjalan di Docker, HTTP Request node dapat menggunakan:

```text
POST http://host.docker.internal:20200/v1/chat/completions
Content-Type: application/json
```

Body minimal:

```json
{
  "model": "auto",
  "messages": [
    {
      "role": "user",
      "content": "{{$json.chatInput}}"
    }
  ],
  "stream": false
}
```

Dengan pola ini, workflow n8n tidak perlu mengetahui model upstream yang sebenarnya.

## 11. Cara memilih mode

Gunakan aturan sederhana berikut:

```text
Tidak tahu harus pilih apa -> auto
Chat ringan               -> fast
Coding                     -> code
Analisis berat/dokumen     -> analysis
Web/current information    -> research
Eksplorasi codebase        -> explore
```

`auto` tetap disarankan sebagai default karena tujuan AutoRouter adalah menghilangkan kebutuhan memilih model secara manual.

## 12. Routing default saat ini

Konfigurasi upstream dapat berubah di `config/routes.json`. Pada konfigurasi repository saat ini, route utama antara lain:

```text
smart-code     -> GPT-5.6 Sol
smart-analysis -> GPT-5.6 Sol
smart-main     -> GPT-5.6 Sol
fast-chat      -> GPT-5.6 Luna
web-research   -> Gemini Flash High
explore        -> Gemini Flash High
```

Setiap route memiliki `selectionPriority` dan fallback. `free-coding` digunakan sebagai emergency global fallback untuk kegagalan upstream yang dikategorikan retryable.

## 13. Mengubah routing

Edit:

```text
config/routes.json
```

Yang dapat diubah antara lain:

- keyword route
- model upstream
- urutan fallback (`selectionPriority`)
- capability `vision`
- capability `tools`
- precedence route

Setelah perubahan, jalankan test dan build:

```bash
npm test
npm run build
```

Lalu restart AutoRouter.

## 14. Troubleshooting

### AutoRouter tidak merespons

```bash
curl -v http://127.0.0.1:20200/health
```

### 9Router tidak merespons

```bash
curl -s http://127.0.0.1:20128/v1/models
```

### Open WebUI/n8n Docker tidak bisa mengakses AutoRouter

Jangan memakai `localhost:20200` dari dalam container. Gunakan:

```text
http://host.docker.internal:20200/v1
```

### Route terlihat salah

Gunakan:

```bash
curl -s http://127.0.0.1:20200/debug/route \
  -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"PROMPT_KAMU"}]}' \
  | python3 -m json.tool
```

## 15. Keamanan

Sebelum push ke GitHub:

```bash
git status
git diff --cached

git grep -n -Ei \
'AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_|AKIA[0-9A-Z]{16}' \
|| echo "Tidak menemukan pola credential umum"
```

Jangan pernah commit:

- `.env`
- API key
- access token
- password
- session/cookie
- credential provider

## 16. Workflow harian yang disarankan

```text
Chat / bertanya
-> Open WebUI -> auto

Informasi terbaru
-> Open WebUI -> auto/research + Web Search

Coding repository
-> OpenCode -> AutoRouter

Automation
-> n8n -> AutoRouter

Debug routing
-> /debug/route

Cek service
-> /health
```

Tujuan akhirnya sederhana: **user menentukan pekerjaan, AutoRouter menentukan route/model, dan 9Router menangani provider/upstream.**
