# Migrar una instancia existente a la 065

La migración `0026` es aditiva (`messaging_account_id`, anulable) y se aplica
sola al arrancar el contenedor. Sin hacer nada más, la instancia sigue igual
que en la 2.5: una sola ID para todo. Estos pasos son para aprovechar la
Cuenta de mensajes.

## Antes de empezar

1. Ten a mano las tres IDs (Business Settings del portafolio del cliente):
   - **Cuenta de WhatsApp**: Cuentas › Cuentas de WhatsApp (la «WABA» de
     siempre; tiene el número).
   - **Cuenta de mensajes**: Cuentas › Cuentas de mensajes (también aparece
     en Facturación y pagos; tiene las plantillas y la tarjeta).
   - **Phone Number ID**: Administrador de WhatsApp.
2. Confirma que el usuario del sistema del token tiene **acceso total a las
   dos cuentas** (Usuarios del sistema › Asignar activos › *WhatsApp accounts*
   y *Messaging accounts › Linked accounts*). El mismo token sirve en cuanto
   se asigna; no hay que regenerarlo.

## Caso A — instancia normal (`waba_id` = Cuenta de WhatsApp)

Ajustes → WhatsApp → «Reconectar / actualizar el número»: pega la ID de la
Cuenta de mensajes en el campo nuevo, pega el token y **Guardar**. Por API:

```bash
curl -X PUT "$APP/api/settings/whatsapp" -H "cookie: $SESION" \
  -H "content-type: application/json" \
  -d '{"wabaId":"<CUENTA_WA>","phoneNumberId":"<PHONE_ID>","token":"<TOKEN>","messagingAccountId":"<CUENTA_MENSAJES>"}'
```

La respuesta trae `webhook.messagingAccount`: `{"ok":true}` = suscrita y con
override confirmado.

## Caso B — instancia con el parche (`waba_id` = Cuenta de mensajes)

Es la del caso AvisaPe (28-oct-2026): para que las plantillas funcionaran se
guardó la ID de la cuenta de mensajes como «WABA ID». Al actualizar a la 065,
ponla en su sitio con el mismo `PUT` del caso A:

- `wabaId` → la **Cuenta de WhatsApp** (la que tiene el número).
- `messagingAccountId` → la **Cuenta de mensajes** (la que estaba en `wabaId`).

Por qué conviene aunque el parche funcione: la CAPI de atribución manda
`waba_id` como `whatsapp_business_account_id` y espera la Cuenta de WhatsApp.

Qué pasa con los webhooks durante el cambio: el override que se puso a mano
en la cuenta de mensajes es de esta instancia (misma ruta), así que no se
toca; la cuenta de WhatsApp se re-suscribe si no tenía override, y el del
número se confirma. Ninguna de las tres suscripciones se quita en el
proceso; aun así, haz el cambio con un mensaje de prueba a mano (paso 5 de
«Comprobar»).

## Comprobar

1. Ajustes → WhatsApp: los dos avisos en verde («Webhook registrado en Meta» y
   «… también en la Cuenta de mensajes»).
2. `GET /{CUENTA_MENSAJES}/subscribed_apps` con el token: la app aparece con
   `override_callback_uri` = la URL de la instancia.
3. Plantillas → **Sincronizar**: aparecen `hello_world` y las creadas en el
   Administrador de WhatsApp (las que Vocero sabe enviar).
4. Crear una plantilla de prueba desde Vocero → queda «pendiente» (antes:
   «Invalid parameter»). Bórrala después en el Administrador si no se usa.
5. Un mensaje real al número entra a la Bandeja.

## Si algo falla

- `webhook.messagingAccount.code = "missing_permission"`: falta asignar la
  Cuenta de mensajes al usuario del sistema (paso 2 de «Antes de empezar»).
- Crear plantilla dice «Meta ya no crea plantillas en la cuenta de WhatsApp»:
  la instancia no tiene `messagingAccountId`; agrégalo.
- Volver atrás: el mismo `PUT` con `"messagingAccountId": ""` borra la ID y
  la instancia vuelve al comportamiento de una sola ID.
