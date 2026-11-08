# Tasks: Conectar el número con «Conectar con Meta» (Embedded Signup v4)

**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md)

- [x] T001 `env.ts`: `META_APP_ID`, `META_EMBEDDED_CONFIG_ID`
- [x] T002 `client.ts`: `MetaApiError.subcode`; `connect.ts`: `2388339` no fatal con Cuenta de mensajes
- [x] T003 `server/whatsapp/embedded.ts`: configuración, canje, número, registro con PIN, alta completa
- [x] T004 Ruta `GET`/`POST /api/settings/whatsapp/embedded`
- [x] T005 `lib/meta/signup-event.ts` + tarjeta `embedded-signup.tsx` montada en el asistente
- [x] T006 wa-mock: `oauth/access_token`, `phone_numbers`, `register`
- [x] T007 Pruebas unitarias (`tests/unit/embedded-signup.test.ts`, caso 2388339 en `cuenta-de-mensajes.test.ts`)
- [x] T008 Arnés E2E `scripts/e2e-embedded-signup.mjs` (31 checks, API + navegador con el SDK simulado) + guion `tests/e2e/us-embedded-signup.md`
- [x] T009 Docs: `.env.example`, `docs/embedded-signup.md`, README, INSTALL-IA, AGENTS, `specs/README.md`, CHANGELOG
- [x] T010 Gates: typecheck, lint, test, build
- [ ] T011 Verificación en vivo en la instancia del cliente (CA-8)
