# 066 — Conectar el número con «Conectar con Meta» (Embedded Signup v4)

**Feature Branch**: `claude/embedded-signup-69fdc7`

**Created**: 2026-10-29

**Status**: Especificada antes de escribir código. Implementada; typecheck,
lint, pruebas unitarias, build y el arnés E2E contra el wa-mock en verde. Sin
verificar todavía contra Meta real (ver «Pendiente»).

**Input**: una instancia de cliente (Vocero 2.6, app de Meta propia del
negocio) va a App Review con `whatsapp_business_messaging`,
`whatsapp_business_management` y `public_profile`. Para demostrar
`public_profile` hace falta el diálogo de Facebook Login for Business, y
Vocero solo sabía conectar un número pegando WABA ID + Phone Number ID +
token. Un fork de cliente ya lo resolvió (su spec 104, probada con otra app);
aquí se porta la parte de Embedded Signup normal.

**Carril**: ciclo completo (Principio VI): rutas nuevas y dos variables de
entorno nuevas. **Sin migración**: no hay tablas ni columnas nuevas.

## Qué se porta y qué no

| Del fork (spec 104) | Aquí |
|---|---|
| Popup v4 (`FB.login` con `config_id`, `response_type: "code"`, `override_default_response_type: true`, `extras` v4) | Sí |
| Canje del `code` por `node:https`, sin la URL (con el secreto) en trazas | Sí |
| Verificar que el número sea de la WABA autorizada | Sí |
| `POST /{phone}/register` con PIN | Sí. El PIN lo genera el servidor si el dueño no escribe uno |
| Webhook por el mismo camino del alta manual | Sí, **más** la Cuenta de mensajes del split de 2026 (065) |
| **Coexistencia** (`featureType: whatsapp_business_app_onboarding`, sincronizar contactos e historial, `history`, `smb_app_state_sync`, `account_update`) | **No.** Es otra superficie (tres webhooks nuevos, una tabla, reglas de ingesta del historial) y ningún caso de la raíz la pide hoy. Queda como spec aparte. Si Meta manda un evento de coexistencia, se rechaza sin tocar nada |
| Intento de un solo uso en BD (`meta_signup_attempt`) | **No.** Sin coexistencia ya no hay opción que amarrar al intento, y el `code` de Meta ya es de un solo uso y caduca. Basta con sesión + rol de configuración + mismo origen + límite de tasa. Así no hay migración |

## Historias

### H1 — El botón solo aparece si la instancia tiene la app

En **Ajustes → WhatsApp**, arriba del formulario manual, aparece la tarjeta
**«Conectar con Meta»** cuando la instancia tiene las tres variables:

| Variable | Qué es |
|---|---|
| `META_APP_ID` | El App ID de la app de Meta (Panel de la app › Configuración › Básica) |
| `META_EMBEDDED_CONFIG_ID` | El ID de la configuración de Facebook Login for Business (variación *WhatsApp Embedded Signup*) |
| `META_APP_SECRET` | El secreto de esa **misma** app. Ya existía: firma los webhooks. Aquí además canjea el `code` |

Si falta cualquiera, la tarjeta no se dibuja, `GET`/`POST
/api/settings/whatsapp/embedded` responden 404 y el formulario manual queda
como hoy.

La tarjeta la puede usar quien configura la instancia (`owner` o `admin`,
`canConfigure`). Un `member` ve el texto «Solo quien administra la cuenta
puede conectar WhatsApp».

### H2 — El popup

- Se carga el JS SDK de Meta (`connect.facebook.net/es_LA/sdk.js`) solo
  cuando la tarjeta aparece.
- `FB.init({ appId, version, xfbml: false, cookie: false, fedCM: false })`.
  `fedCM: false` es obligatorio: con FedCM el SDK descarta `config_id`,
  `response_type` y `extras`, y nunca llega el `code` (caso documentado en
  la base de conocimiento de Meta de Kevin, §12.1).
- `version` = `META_GRAPH_API_VERSION` (la misma de la Graph API).
- `FB.login` se llama **directo en el clic** (un `await` antes y el navegador
  bloquea la ventana) con:

  ```js
  {
    config_id,
    response_type: "code",
    override_default_response_type: true,
    extras: { setup: {}, sessionInfoVersion: "3", version: "v4" },
  }
  ```

- El `code` (callback de `FB.login`) y el evento de sesión (`message` de
  `facebook.com` con `type: "WA_EMBEDDED_SIGNUP"`) llegan en cualquier orden.
  Se manda al servidor cuando están los dos.

| Evento | Qué se hace |
|---|---|
| `FINISH` / `FINISH_ONLY_WABA` | Se guarda `waba_id` y `phone_number_id` (puede faltar) |
| `CANCEL` | «La conexión se canceló en Meta. Puedes volver a intentarlo.» |
| `ERROR` | Lo mismo, con el mensaje de Meta si vino |
| `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` | Coexistencia, fuera de alcance: se avisa y no se manda nada |
| Callback sin `code` | «Meta no autorizó la conexión.» |

Solo se aceptan mensajes de `https://www.facebook.com`,
`https://web.facebook.com` y `https://business.facebook.com`.

### H3 — El servidor termina el alta

`POST /api/settings/whatsapp/embedded` con `{ code, wabaId, phoneNumberId,
pin }`:

1. **Canje**: `GET /{versión}/oauth/access_token?client_id&client_secret&code`
   (sin `redirect_uri`: el flujo del SDK de JS no lo usa). Por `node:https`,
   no por `fetch`, para que la URL con el secreto no termine en trazas.
2. **Número**: `GET /{waba}/phone_numbers` con el token nuevo. Con
   `phoneNumberId` del evento, tiene que estar en la lista; sin él, se usa el
   único número de la WABA (con varios o ninguno, falla sin guardar). Un
   número `ON_PREMISE` se rechaza.
3. **Registro**: si el número no está `CONNECTED`, `POST /{phone}/register`
   con `messaging_product: "whatsapp"` y el PIN. El PIN es el que escribió el
   dueño (si el número ya tenía verificación en dos pasos) o uno de 6 dígitos
   generado con `crypto.randomInt`. Si Meta no confirma, falla sin guardar.
4. **Cuenta de mensajes** (065): `descubrirCuentaDeMensajes(waba, token)`,
   best-effort.
5. **Credenciales**: `saveCredentials` (cifradas, reemplazan la conexión
   anterior), igual que el alta manual.
6. **Webhook**: `registerWebhookForNumber` con la Cuenta de mensajes, igual
   que el alta manual: suscribe la app (y el override) en la Cuenta de
   WhatsApp y en la de mensajes, y pone el override en el número.

Nada se guarda si fallan los pasos 1-3: la conexión anterior se conserva. El
resultado del webhook va aparte, como en el alta manual: si Meta lo rechaza,
el número ya quedó guardado y la tarjeta del webhook ofrece reintentar.

Ni el `code`, ni el token, ni el secreto aparecen en logs, respuestas ni
errores. El PIN **generado** se devuelve una sola vez en la respuesta para que
el dueño lo guarde (es la verificación en dos pasos de su número; sin él no
podría volver a registrarlo en otro lado). No se guarda en la base.

### H4 — `2388339` en la Cuenta de WhatsApp no es fatal

Desde el 28-oct-2026 Meta responde `#100` subcode `2388339` (*«This API is
not supported for this WhatsApp Business Account»*) a `POST
/{cuenta_de_WhatsApp}/subscribed_apps` en las cuentas ya partidas. Lo que hace
llegar los mensajes en esas cuentas es la suscripción con override en la
Cuenta de mensajes.

En `registerWebhookForNumber` (afecta también al alta manual y a
«Registrar el webhook»):

- `2388339` en la Cuenta de WhatsApp **con** Cuenta de mensajes: se sigue; si
  la de mensajes respondió bien, se registra el override del número y el
  resultado es `ok`. Si la de mensajes también falló, se devuelve ese error.
- `2388339` **sin** Cuenta de mensajes conocida: error con un mensaje que dice
  qué hacer (escribir la ID de la Cuenta de mensajes en el formulario).

## Lo que va en el panel de Meta (fuera del código)

Documentado en [docs/embedded-signup.md](../../docs/embedded-signup.md):

1. **Facebook Login for Business › Configuraciones › Crear configuración**:
   variación *WhatsApp Embedded Signup*; producto **solo WhatsApp Cloud API**;
   vencimiento del token **Nunca**; permisos `whatsapp_business_management`
   y `whatsapp_business_messaging`. El ID es `META_EMBEDDED_CONFIG_ID`.
2. **Facebook Login for Business › Configuración**: *Inicio de sesión con
   OAuth de cliente*, *Inicio de sesión con OAuth web*, *Forzar HTTPS*,
   *Inicio de sesión con el SDK para JavaScript* en **Sí**; el dominio de la
   instancia (HTTPS) en *URI de redireccionamiento de OAuth válidos*
   (`https://<dominio>/`) y en *Dominios permitidos para el SDK para
   JavaScript* (`https://<dominio>`).
3. **Configuración › Básica**: el dominio en *Dominios de la app*.

## Fuera de alcance

- Coexistencia (ver tabla de arriba).
- Modo Tech Provider multi-cliente (la agencia conecta números de varios
  negocios en una instancia): una instancia = un negocio.
- Desautorización y callback de eliminación de datos de la app.

## Criterios de aceptación

- **CA-1** Sin `META_APP_ID` + `META_EMBEDDED_CONFIG_ID` + `META_APP_SECRET`,
  la tarjeta no aparece y la ruta responde 404.
- **CA-2** Solo `owner`/`admin`, solo desde el mismo origen, con límite de
  tasa.
- **CA-3** Un número que no es de la WABA, o una WABA con varios números sin
  `phone_number_id`, falla sin guardar nada.
- **CA-4** El número se registra con un PIN generado si no está `CONNECTED`;
  si ya lo está, no se llama a `/register`.
- **CA-5** El webhook se registra en la Cuenta de WhatsApp, en la de mensajes
  (si se descubre) y en el número.
- **CA-6** `2388339` en la Cuenta de WhatsApp no tumba el registro si la de
  mensajes respondió bien.
- **CA-7** Ni el `code`, ni el token, ni el secreto salen en la respuesta ni
  en los logs.
- **CA-8** En vivo: el número del cliente conectado con el popup, un mensaje
  real que entra a la bandeja. **Depende del panel de Meta.**

## Pendiente

- CA-8 en la instancia del cliente (la hace la sesión que graba el video).
