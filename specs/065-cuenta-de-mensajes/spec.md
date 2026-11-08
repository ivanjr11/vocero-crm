# 065 — La Cuenta de mensajes de Meta y las plantillas creadas fuera de Vocero

**Feature Branch**: `feat/065-cuenta-de-mensajes`

**Created**: 2026-10-28

**Status**: Especificada antes de escribir código. Implementada; typecheck, lint
y pruebas unitarias en verde. Sin verificar todavía contra Meta real (ver
«Pendiente»).

**Input**: dos fallas vistas en producción el 2026-10-28 en una instancia de
cliente (Vocero 2.5.0, App Review de un Tech Provider):

1. Crear una plantilla desde Vocero daba «Invalid parameter». Meta respondía
   `#100`, subcode `2388339`: *«This API is not supported for this WhatsApp
   Business Account»*. La misma llamada sobre la **Cuenta de mensajes** sí
   funcionó. Y los mensajes entrantes no llegaron hasta suscribir la app,
   con override, **también** a la Cuenta de mensajes.
2. `hello_world` y las plantillas creadas en el Administrador de WhatsApp
   nunca aparecían en Vocero: el sync solo actualizaba las que Vocero había
   creado. El fork de un cliente ya lo resolvió (su spec 101); aquí se porta.

**Carril**: ciclo completo (Principio VI): migración aditiva `0026` y un campo
nuevo, opcional, en el DTO de `GET`/`PUT /api/settings/whatsapp` (lo consume
el script de instalación agéntica, fuera de este repo).

## Contexto: el split de 2026

Meta partió la antigua WABA en dos activos (doc oficial *«WhatsApp accounts
and Messaging accounts»*):

| Activo | Qué tiene | En Vocero |
|---|---|---|
| **Cuenta de WhatsApp** (la «WABA» de siempre) | El número y la presencia de la empresa | `meta_credentials.waba_id` |
| **Cuenta de mensajes** | Las **plantillas** y el **método de pago** | `meta_credentials.messaging_account_id` (nuevo) |

Lo comprobado en el caso real (2026-10-28):

- `POST /{cuenta_de_WhatsApp}/message_templates` → `#100/2388339`.
  `POST /{cuenta_de_mensajes}/message_templates` → `PENDING`.
- `GET …/message_templates` todavía responde por las dos rutas.
- Con la app suscrita y con override en la cuenta de WhatsApp y en el
  número, los entrantes **no llegaban**. `POST /{cuenta_de_mensajes}/subscribed_apps`
  con `override_callback_uri` + `verify_token` → llegaron al instante.
- El usuario del sistema necesita acceso a las dos cuentas; el mismo token
  sirve en cuanto se le asigna la de mensajes.

Hay WABA viejas que todavía no tienen Cuenta de mensajes, e instancias que hoy
guardan una sola ID (alguna, como parche, la de la cuenta de mensajes). Las
dos cosas tienen que seguir funcionando igual que antes.

## Decisiones

**D1 — Se guardan las dos IDs; la de mensajes es opcional.**

- Columna nueva, anulable: `meta_credentials.messaging_account_id`.
- `waba_id` sigue siendo la **Cuenta de WhatsApp**: es la que va en la CAPI
  (`whatsapp_business_account_id`) y la que tiene el número.
- Sin `messaging_account_id`, todo se comporta exactamente como en la 2.5.

**D2 — Cada llamada va a la cuenta que le toca.**

| Llamada | Cuenta |
|---|---|
| Crear plantilla (`POST …/message_templates`) | Mensajes; si no hay, WhatsApp |
| Sincronizar plantillas (`GET …/message_templates`) | Mensajes; si no hay, WhatsApp |
| Evento `message_template_status_update` (se enruta por `entry.id`) | Se reconoce por **cualquiera** de las dos |
| `subscribed_apps` + override del webhook | **Las dos** (D3) |
| Override del número, envío, medios | El número (sin cambios) |
| CAPI | WhatsApp (sin cambios) |

**D3 — Al guardar la conexión (y con «Registrar en Meta»), el webhook se
registra también en la Cuenta de mensajes.**

Si hay `messaging_account_id`, además de lo de siempre (suscripción a la
cuenta de WhatsApp + override del número):

1. `GET /{cuenta_de_mensajes}/subscribed_apps`. Si ya hay un override de
   ESTA instancia (misma ruta `/api/webhooks/wa/<verify token>`), no se toca.
   Si hay uno **ajeno**, se respeta y se informa, igual que con la cuenta de
   WhatsApp (salvo «Recuperar el webhook», que lo reemplaza).
2. `POST /{cuenta_de_mensajes}/subscribed_apps` con
   `override_callback_uri` + `verify_token`.
3. Se relee para confirmar.

El resultado viaja en `webhook.messagingAccount` de la respuesta y la tarjeta
lo muestra. Un fallo aquí **no** deshace el guardado ni cambia el resultado
del número: se avisa con el motivo (casi siempre: el usuario del sistema no
tiene asignada la Cuenta de mensajes). Si la cuenta de WhatsApp ya enruta a un
override ajeno, la de mensajes tampoco se toca.

Al **desconectar**, si el override de la cuenta de mensajes es de esta
instancia, se quita (`POST …/subscribed_apps` sin cuerpo, la forma que Meta
documenta para borrar el callback alterno). Best-effort, como el del número.

**D4 — La ID de la Cuenta de mensajes se pide; descubrirla es un extra.**

- El asistente de conexión y `PUT /api/settings/whatsapp` aceptan
  `messagingAccountId` (opcional).
- Si no viene **y** no había una guardada, se intenta descubrir con
  `GET /{waba}?fields=paid_messaging_account_id`. **NEEDS CLARIFICATION**:
  ese campo lo citan terceros y no está confirmado en la doc oficial (y hay
  quien lo da por deprecado al 31-dic-2026). Si Meta lo rechaza o no
  devuelve nada, se guarda sin ella, sin error.
- Semántica del `PUT`: campo ausente → se conserva la guardada (rotar el
  token no la borra); cadena vacía → se borra a propósito.

**D5 — Crear una plantilla en la cuenta equivocada dice qué hacer.** Si Meta
responde `2388339` y no hay Cuenta de mensajes guardada, el error ya no es un
«Invalid parameter»: dice que Meta ahora crea las plantillas en la Cuenta de
mensajes y que se agregue su ID en Ajustes → WhatsApp.

**D6 — El sync importa las plantillas que ya existen en Meta** (puerto de la
spec 101 del fork).

- Pide `fields=id,name,language,status,category,rejected_reason,components`
  y recorre **toda** la paginación (`limit=100`, sigue `paging.next` hasta el
  final; se corta si Meta repite un cursor, con una red de 100 páginas =
  10.000 plantillas, por encima del máximo de 6.000 que Meta permite).
- Importa solo lo que Vocero sabe enviar: categoría UTILITY o MARKETING,
  cuerpo con variables válidas, encabezado de texto fijo, pie y botones sin
  variables. Encabezado multimedia o con variable, botón de URL dinámica,
  OTP o AUTHENTICATION **no** se importan: Meta los rechazaría al enviar sin
  esos parámetros.
- La importada guarda su `wa_template_id` y su estado real (aprobada,
  pendiente o rechazada con motivo). Lo que ya existía sigue el camino de
  siempre (estado y categoría).

## Criterios de aceptación

1. Con `messaging_account_id`, crear una plantilla llama
   `POST /{messaging_account_id}/message_templates`; sin ella, a `waba_id`.
2. Con `messaging_account_id`, el sync lee `/{messaging_account_id}/message_templates`.
3. Sin `messaging_account_id` y respuesta `2388339`, el error menciona la
   Cuenta de mensajes y Ajustes → WhatsApp.
4. Un evento de plantilla con `entry.id` = la cuenta de mensajes actualiza la
   plantilla de esa organización.
5. Guardar con `messagingAccountId` hace `subscribed_apps` + override en la
   cuenta de mensajes y lo confirma; el resultado sale en
   `webhook.messagingAccount`. Sin ella, las llamadas a Meta son idénticas a
   las de la 2.5.
6. Un override ajeno en la cuenta de mensajes se respeta (salvo «Recuperar»).
7. Un error de Meta en la cuenta de mensajes no cambia `webhook.ok` del número.
8. `PUT` sin `messagingAccountId` conserva la guardada; con `""` la borra; sin
   guardada intenta descubrirla y, si no puede, guarda igual.
9. Desconectar quita el override de la cuenta de mensajes si es nuestro.
10. `hello_world` aparece aprobada tras «Sincronizar»; una plantilla con
    encabezado de imagen no se importa.
11. La migración es aditiva: una instancia con una sola ID arranca y opera
    igual que antes.

Verificable: `tests/unit/cuenta-de-mensajes.test.ts`,
`tests/unit/templates.test.ts` (`importableTemplate`) y las suites de
registro del webhook y de la ruta de conexión.

## Qué NO se hace y por qué

- **No se vuelve obligatoria la Cuenta de mensajes.** Hay WABA sin ella y
  romper instancias vivas por un campo nuevo es peor que una plantilla que
  falla con un mensaje claro.
- **No se migran datos solos.** Una instancia que hoy guarda la ID de la
  cuenta de mensajes en `waba_id` (el parche) sigue funcionando; ponerla en su
  lugar es un paso manual documentado en [migrar.md](migrar.md).
- **No se importan plantillas con encabezado multimedia o botones
  dinámicos**: haría falta pedir esos parámetros en el compositor.
- **No se usa la Cuenta de mensajes para enviar**: el envío sigue saliendo
  por el número; lo que necesita es que el token tenga acceso a ella.

## Pendiente

- Verificar en vivo, sobre la instancia del caso real y con el OK de Kevin,
  los pasos de [migrar.md](migrar.md).
- Confirmar si `paid_messaging_account_id` existe (D4).
