# Plan: La Cuenta de mensajes de Meta y las plantillas creadas fuera de Vocero

**Spec**: [spec.md](spec.md) · **Tasks**: [tasks.md](tasks.md) · **Migrar**: [migrar.md](migrar.md)

## Modelo de datos

`meta_credentials.messaging_account_id text NULL` — migración `0026`
(`ADD COLUMN IF NOT EXISTS`, re-ejecutable). Sin índice: la tabla tiene una
fila por organización y solo se busca por esta columna al enrutar un evento de
plantilla.

`Credentials.messagingAccountId: string | null` y
`cuentaDePlantillas(creds)` = `messagingAccountId || wabaId`, en
`src/server/whatsapp/credentials.ts`. `getCredentialsByWabaId` reconoce
cualquiera de las dos IDs. `saveCredentials` acepta `messagingAccountId`:
`undefined` no toca la columna en un update; `null` la borra.

## Contratos

`GET /api/settings/whatsapp` → `connection.messagingAccountId` (nuevo).

`PUT /api/settings/whatsapp`:
- entrada: `messagingAccountId?: string` (solo dígitos; vacía = borrar);
- salida: `messagingAccountId` resuelto y `webhook.messagingAccount?`.

`POST /api/settings/webhook` → `messagingAccount?` en el resultado.

Todo es aditivo: un cliente que no manda ni lee el campo ve lo mismo que en
la 2.5 (la única diferencia sin la ID es el intento de descubrimiento, que no
falla nunca).

## Código

| Archivo | Cambio |
|---|---|
| `src/lib/db/schema.ts` + `drizzle/0026_cuenta_de_mensajes.sql` | columna |
| `src/server/whatsapp/credentials.ts` | tipo, `cuentaDePlantillas`, lookup por las dos IDs, guardar |
| `src/server/whatsapp/connect.ts` | `registerWebhookForMessagingAccount` (interno), `unregisterWebhookForMessagingAccount`, `descubrirCuentaDeMensajes`, `messagingAccount` en el resultado |
| `src/server/whatsapp/templates.ts` | crear/sync en `cuentaDePlantillas`, `esCuentaSinPlantillas` (2388339), `importableTemplate`, paginación |
| `src/app/api/settings/whatsapp/route.ts` | campo, resolución (venida → guardada → descubierta), baja al desconectar |
| `src/app/api/settings/webhook/route.ts` | pasa la ID guardada |
| `src/components/settings/whatsapp-wizard.tsx` | campo opcional y aviso de la cuenta de mensajes |

## Orden dentro de `registerWebhookForNumber`

1. Cuenta de WhatsApp: override ajeno → `skipped` (y no se toca la de
   mensajes). Si no, suscripción como siempre.
2. Cuenta de mensajes (si hay y es distinta de `wabaId`): GET → nuestro: nada;
   ajeno: respetar salvo `forzar`; si no, POST con override → relectura.
3. Número: override + confirmación (sin cambios).

El paso 2 no corta el flujo: su resultado se adjunta al del número.

## Riesgos

- `paid_messaging_account_id` puede no existir: el descubrimiento devuelve
  `null` ante cualquier error, y la UI pide la ID de todos modos.
- Un `POST …/subscribed_apps` con override sobre una cuenta de mensajes que ya
  tuviera otra app con override ajeno: no se hace sin `forzar`.
