# FotoPacients Agent

Windows-агент для швидкого завантаження КТ-архівів та аналізів пацієнтів у систему FotoPacients.

**Стек:** Tauri v2 + React 19 + TypeScript.

## Можливості

- **КТ-режим** (на ПК КТ-апарату): drag&drop архіву (ZIP/RAR/ISZ/7z) → прив'язка до прийому пацієнта → завантаження на локальну ноду.
- **Аналіз-режим** (ресепшен): drag&drop фото/PDF → прикріплення до картки пацієнта.
- **Auto-detect ноди** через discovery endpoint — IP не зашиваються в `.exe`, агент бере свіжий конфіг з сервера при кожному запуску.
- **Failover**: якщо локальна нода недоступна — автоматично перемикає на резервну.
- **Авторизація** через номер телефону + код у Telegram (як на photo.vidnova.app).
- **Tray** + autostart з Windows.
- **Upload queue** з паралельними завантаженнями + retry.
- **Auto-update** через GitHub Releases (signed signature).

## Розробка

```bash
npm install
npm run tauri dev
```

## Build .exe

Локально:
```bash
npm run tauri build
```

Через CI: створи git tag `v0.1.0` → push → GitHub Actions автоматично збере + опублікує реліз з `.msi`/`.nsis.zip` + `latest.json`.

## Перший запуск (на ПК клініки)

1. Завантаж `.msi` з [Releases](https://github.com/Alex1981-tech/fotopacients-agent/releases/latest)
2. Установка one-click (без UAC якщо запускаєш без admin прав)
3. При першому запуску: ввести номер телефону → код з Telegram
4. Вибрати режим (КТ / Аналізи) в налаштуваннях
5. Програма сидить у tray; вікно відкривається кліком

## Конфігурація серверної сторони

У `.env` Django-сервера (LV/HD/ZP):
```env
AGENT_NODES_JSON=[{"id":"LV","label":"Львів","lan_url":"http://192.168.91.92","ts_url":"http://100.73.208.118"},...]
AGENT_FALLBACK_URL=https://photo.vidnova.app
```

Агент тягне цей список через `GET /api/agent/config/` — IP можна міняти без перевипуску `.exe`.

## Налаштування CI

Один раз створи Tauri signing key:
```bash
npx tauri signer generate -w ~/.tauri/fotopacients-agent.key
```

Public key → у `src-tauri/tauri.conf.json`, поле `plugins.updater.pubkey`.
Private key → у GitHub Secrets: `TAURI_SIGNING_PRIVATE_KEY`.

## Структура

```
src/
├── lib/
│   ├── api.ts          # HTTP клієнт з Token auth
│   ├── node-picker.ts  # discovery + ping ноди
│   ├── store.ts        # tauri-plugin-store wrapper
│   ├── types.ts
│   └── upload.ts       # upload queue (parallel, retry)
├── components/         # LoginScreen, PatientSearch, Settings, UploadQueue
├── modes/              # CTMode, AnalysisMode
├── App.tsx
├── main.tsx
└── styles.css          # iOS-стиль (як photo.vidnova.app)

src-tauri/
├── Cargo.toml
├── src/
│   ├── main.rs
│   └── lib.rs          # tray + autostart + single-instance
├── capabilities/
└── tauri.conf.json
```
