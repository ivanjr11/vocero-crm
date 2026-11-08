# Tasks: La Cuenta de mensajes de Meta y las plantillas creadas fuera de Vocero

**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md)

- [x] T001 `messagingAccountId` en `schema.ts`, `pnpm db:generate` → `0026` (con `IF NOT EXISTS`)
- [x] T002 `credentials.ts`: tipo, `cuentaDePlantillas`, lookup por las dos IDs, guardar sin pisar la guardada
- [x] T003 `connect.ts`: registro, baja y descubrimiento en la Cuenta de mensajes
- [x] T004 `templates.ts`: crear y sincronizar en la cuenta de plantillas; error claro con 2388339
- [x] T005 `templates.ts`: `importableTemplate` + paginación + importar en el sync (puerto de la 101 del fork)
- [x] T006 Rutas `PUT`/`GET`/`DELETE /api/settings/whatsapp` y `POST /api/settings/webhook`
- [x] T007 Asistente de conexión: campo opcional y aviso de la cuenta de mensajes
- [x] T008 `tests/unit/cuenta-de-mensajes.test.ts`, `importableTemplate` en `templates.test.ts`, casos 065 en `whatsapp-save-webhook.test.ts`
- [x] T009 Gates: typecheck, lint, test (y build)
- [x] T010 `migrar.md`, `specs/README.md`
- [ ] T011 Verificación en vivo en la instancia del caso real (con el OK de Kevin) y confirmar `paid_messaging_account_id`
- [x] T012 Ampliar el arnés E2E (wa-mock: responder 2388339 en la cuenta de WhatsApp) y PR — `scripts/e2e-cuenta-de-mensajes.mjs` (36 checks) + guion `tests/e2e/us-cuenta-de-mensajes.md`
