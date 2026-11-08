# Guion E2E — Fondo del chat con dibujos (063)

> Automatizado en `scripts/e2e-diseno-061.mjs` (los checks «063 ·»). Spec:
> [063](../../specs/063-fondo-chat-dibujos/spec.md).

## Por qué

Kevin quería el fondo de WhatsApp con dibujos propios, y entre ellos los de la
casa: un carnero, un pulpo, un plato de DJ y la diosa de AISHIA.

## Camino verificado

Entra una conversación y sale una respuesta. Luego:

1. **FC-1.** En claro, la tarjeta del chat lleva `fondo-chat/claro.svg`; en
   oscuro, `fondo-chat/oscuro.svg`.
2. **FC-2.** El compositor es transparente: no tapa los dibujos.
3. **FC-1.** Los dos SVG se sirven como `image/svg+xml`.
4. **FC-3.** Con Alto contraste (cookie `vocero-apariencia`), la tarjeta del
   chat no lleva dibujos.
5. Sin errores de la página.
