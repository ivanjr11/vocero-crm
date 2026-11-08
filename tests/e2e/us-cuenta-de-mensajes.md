# Guion E2E — 065: la Cuenta de mensajes y las plantillas creadas fuera de Vocero

> Automatizado en `scripts/e2e-cuenta-de-mensajes.mjs` (36 checks):
> `pnpm test:e2e:cuenta-de-mensajes` con la app viva y el wa-mock encendido.
> Reproduce las dos fallas vistas en producción el 28-oct-2026.

El wa-mock parte una cuenta de WhatsApp como Meta desde 2026
(`POST /api/dev/wa-mock/cuenta-de-mensajes`): pedirle plantillas responde
`#100` subcode `2388339`, y solo la Cuenta de mensajes las acepta. La misma
llamada siembra plantillas creadas fuera de Vocero, más de 100 para forzar la
segunda página.

## Sin la Cuenta de mensajes

1. Guardar la conexión solo con la WABA partida.
   ✅ Se guarda; no se inventa una Cuenta de mensajes si Meta no la revela.
2. Crear una plantilla.
   ✅ Error tipado que dice dónde agregar la Cuenta de mensajes, no
   «Invalid parameter».
3. Sincronizar.
   ✅ Error tipado, sin colgarse.

## Con la Cuenta de mensajes

4. Guardar con `messagingAccountId`.
   ✅ El webhook queda en las dos cuentas (`webhook.messagingAccount.ok`) y el
   override de la instancia está en la Cuenta de mensajes.
5. Crear una plantilla.
   ✅ Queda «Pendiente de Meta».
6. Sincronizar.
   ✅ Importa `hello_world`, la de encabezado de texto + pie + botones fijos y
   la rechazada (con su estado). NO importa encabezado con imagen,
   AUTHENTICATION ni botón de URL dinámica. Recorre toda la paginación.
   ✅ Un segundo sync no duplica ni reescribe.
7. Webhook `message_template_status_update` con `entry.id` = Cuenta de mensajes.
   ✅ La plantilla pasa a aprobada.
8. Iniciar conversación con `hello_world` importada.
   ✅ A Meta le llega la plantilla con su nombre e idioma.

## Caminos infelices y mantenimiento

9. Rotar el token sin mandar la Cuenta de mensajes → se conserva. Mandarla
   vacía → se borra. Una ID no numérica → 400/422.
10. Desconectar → el override de la instancia sale de la Cuenta de mensajes.
11. Una WABA que sí revela `paid_messaging_account_id` → se guarda sola.
