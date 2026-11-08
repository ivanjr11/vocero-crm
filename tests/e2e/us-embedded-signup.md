# Guion E2E — 066: «Conectar con Meta» (Embedded Signup v4)

> Automatizado en `scripts/e2e-embedded-signup.mjs` (31 checks):
> `pnpm test:e2e:embedded-signup` con la app viva, el wa-mock encendido y
> `META_APP_ID` + `META_EMBEDDED_CONFIG_ID` + `META_APP_SECRET` en el entorno.

El wa-mock imita lo que Meta hace después del popup: canjea un `code` una sola
vez (`oauth/access_token`, exige el secreto de la app), lista los números de
la WABA que el arnés siembra (`POST /api/dev/wa-mock/embedded`) y registra el
número (`{phone}/register`; el PIN `000000` imita un PIN que no coincide). La
cuenta de WhatsApp se parte con `rechazaSuscripcion` para que `subscribed_apps`
responda `#100/2388339`, como desde el 28-oct-2026.

## Por API

1. `GET /api/settings/whatsapp/embedded` como dueño.
   ✅ App ID, Config ID y versión; nunca el secreto.
2. `POST` con el `code`, la WABA partida y el número nuevo, sin PIN.
   ✅ 200 conectado, Cuenta de mensajes descubierta, PIN generado de 6
   dígitos, webhook `ok` pese al 2388339, sin token ni `code` en la respuesta.
   ✅ «Meta» registró el número con ese PIN; el otro número (ya conectado) no.
   ✅ La conexión guardada tiene la WABA, el número y la Cuenta de mensajes.
   ✅ Override de la instancia en la Cuenta de mensajes y en el número.
3. Un entrante al número conectado.
   ✅ El contacto aparece en el CRM.

## Caminos infelices (la conexión buena no cambia)

4. El mismo `code` otra vez → 422 `exchange_failed`, sin el secreto.
5. WABA con varios números y sin `phone_number_id` → 422 `varios_numeros`.
6. Un número que no es de la WABA → 422 `asset_mismatch`.
7. PIN que Meta no acepta → 422 `registration_failed`.
8. Desde otro origen → 403 `invalid_origin`.

## En el navegador

El arnés sirve un SDK de Meta falso en lugar de `connect.facebook.net` y un
iframe en `https://www.facebook.com/…` que manda el evento de sesión, para que
la tarjeta lo acepte por su origen como en producción.

9. Abrir Ajustes → WhatsApp.
   ✅ Aparece la tarjeta y el botón «Conectar con Meta».
   ✅ `FB.init` con el App ID, la versión y `fedCM: false`.
10. Pulsar el botón.
    ✅ `FB.login` con `config_id`, `response_type: "code"`,
    `override_default_response_type: true` y `extras.version: "v4"`.
    ✅ La tarjeta dice «Conectado …» y muestra el PIN generado una vez.
    ✅ El banner de conexión se actualiza sin recargar.

## Sin configuración (pruebas unitarias)

Sin cualquiera de las tres variables, `GET` y `POST` responden 404 y la tarjeta
no se dibuja: `tests/unit/embedded-signup.test.ts`.
