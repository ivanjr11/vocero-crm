# Plan: Conectar el número con «Conectar con Meta» (Embedded Signup v4)

**Spec**: [spec.md](spec.md) · **Tasks**: [tasks.md](tasks.md)

## Modelo de datos

Sin cambios. Las credenciales van a `meta_credentials` con `saveCredentials`,
como el alta manual. El PIN generado no se guarda.

## Configuración

`src/lib/env.ts`: `META_APP_ID` y `META_EMBEDDED_CONFIG_ID` opcionales.
`META_APP_SECRET` ya existía. `embeddedConfig()` (en
`src/server/whatsapp/embedded.ts`) dice si están las tres y solo dígitos en
los dos IDs.

## Contratos

`GET /api/settings/whatsapp/embedded`
- sin configuración → `404`;
- `{ ready: true, canManage: false }` para un `member`;
- `{ ready: true, canManage: true, appId, configId, graphVersion }` para
  quien configura. Nunca el secreto.

`POST /api/settings/whatsapp/embedded`
- entrada: `{ code: string, wabaId: /^\d+$/, phoneNumberId: /^\d+$/ | null, pin: /^\d{6}$/ | null }`;
- `403 forbidden` sin rol; `403 invalid_origin` desde otro origen; `429` con
  más de 10 intentos por minuto;
- `200 { connected: true, displayPhoneNumber, wabaId, phoneNumberId, messagingAccountId, registered, generatedPin?, webhook }`;
- `422`/`503` con `{ error: { code, message } }` si algo falla antes de guardar.

## Código

| Archivo | Cambio |
|---|---|
| `src/lib/env.ts` | dos variables |
| `src/lib/meta/client.ts` | `MetaApiError.subcode` (de `error_subcode`) |
| `src/server/whatsapp/connect.ts` | `2388339` en la Cuenta de WhatsApp no es fatal si la de mensajes respondió bien |
| `src/server/whatsapp/embedded.ts` | `embeddedConfig`, `EmbeddedSignupError`, canje, número, registro, `completarAltaEmbebida` |
| `src/app/api/settings/whatsapp/embedded/route.ts` | `GET` + `POST` |
| `src/lib/meta/signup-event.ts` | leer el evento de sesión y las opciones de `FB.login` (cliente y pruebas) |
| `src/components/settings/embedded-signup.tsx` | la tarjeta |
| `src/components/settings/whatsapp-wizard.tsx` | monta la tarjeta y el aviso del resultado |
| `src/app/api/dev/wa-mock/graph/[...path]/route.ts` | `oauth/access_token`, `{waba}/phone_numbers`, `{phone}/register` |
| `.env.example`, `docs/embedded-signup.md`, `README.md`, `INSTALL-IA.md`, `AGENTS.md` | variables y pasos del panel |

## Riesgos

- El SDK de Meta puede cambiar su configuración remota (FedCM): `fedCM: false`
  fijo en `FB.init`.
- Con el split de 2026 el canje puede devolver un token sin acceso a la Cuenta
  de mensajes si el cliente no la compartió en el popup: el registro de esa
  cuenta falla con `missing_permission` y la tarjeta del webhook lo dice; el
  número queda guardado.
- `paid_messaging_account_id` no está documentado (065): si no se descubre, el
  dueño escribe la ID en el formulario manual y pulsa «Registrar el webhook».
