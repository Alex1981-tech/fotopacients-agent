# FotoPacients Agent

Внутрішній Windows-агент для робочих станцій клініки.

## Розробка

```bash
npm install
npm run tauri dev
```

## Build

Локально:
```bash
npm run tauri build
```

CI: `git tag v0.x.y && git push --tags` — GitHub Actions автоматично збере Windows-бінарник.
