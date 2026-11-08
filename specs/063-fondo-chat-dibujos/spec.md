# 063 — Fondo del chat con dibujos

**Feature Branch**: `feat/063-fondo-chat-dibujos`

**Created**: 2026-10-25

**Status**: Implementada; unitarias y arnés E2E (`scripts/e2e-diseno-061.mjs`, sección 063) en verde. Ya corre en Vocero Cloud (kevinrivm/vocerocrm-cloud#140).

**Input**: Kevin, el 2026-10-25, con una captura del fondo de WhatsApp: «para
el fondo de la ventana de chat, WhatsApp tiene unos vectores que me gustaría
replicar. No exactamente los mismos». Pidió además meter dibujos de la casa:
un carnero (Belier es carnero en francés), un pulpo, unos platos de DJ y uno
parecido al logo de AISHIA. Para el raíz eligió el mismo mosaico que Cloud,
con los cuatro.

**Carril**: ligero (Principio VI). Sin tabla, migración, variable ni contrato.

## Comportamiento

- **FC-1 · Dibujos de fondo.** Detrás de los mensajes va un mosaico de 40
  dibujos en línea propios (burbuja, megáfono, chile, cactus, gato, cohete…,
  más el carnero, el pulpo, el plato de DJ y la diosa de AISHIA). Se repite
  sin costuras cada 440 px y es muy tenue: negro al 8 % en los temas claros y
  blanco al 7 % en los oscuros.
- **FC-2 · Quieto y entero.** El fondo es de la tarjeta del chat, no del hilo:
  no se mueve al desplazar los mensajes y pasa sin cortarse detrás del
  compositor. La pantalla de «Elige una conversación» también lo lleva.
- **FC-3 · Alto contraste va sin dibujos.** Ahí manda que todo se lea.

## Decisiones

- **D1 — Dos SVG, uno por modo** (`public/fondo-chat/claro.svg` y
  `oscuro.svg`). Una imagen de fondo no acepta opacidad ni color desde CSS,
  así que el tono va dentro del SVG. El token `--chat-dibujos` de
  `globals.css` elige el del modo, de modo que vale para los 8 temas y para el
  propio. Alto contraste lo deja en `none`.
- **D2 — Los SVG no se editan a mano.** Salen de
  `scripts/generar-fondo-chat.mjs`, que es determinista: un dibujo se cambia
  ahí y se vuelve a generar.
- **D3 — `.tarjeta` pinta solo `background-color`.** El atajo `background`
  borraba en escritorio la imagen de fondo de lo que también es tarjeta (el
  brillo de `.thread-bg` ya no se veía en la pantalla vacía).
- **D4 — White-label.** Los dibujos de la casa van también aquí, por decisión
  de Kevin. Ninguno lleva texto ni el nombre del producto.

## Verificación

- Unitarias (`tests/unit/temas.test.ts`):
  - claro y oscuro apuntan a su mosaico;
  - los dos SVG existen con el lado del `background-size`;
  - Alto contraste va sin dibujos.
- Arnés `scripts/e2e-diseno-061.mjs`, sección 063. Guion:
  [us-fondo-chat](../../tests/e2e/us-fondo-chat.md).
