# 064 — Lista de conversaciones rápida

**Feature Branch**: `perf/lista-conversaciones-rapida`

**Created**: 2026-10-27

**Status**: Implementada; unitarias (`tests/unit/lista-compartida-064.test.ts`) y
arnés E2E (`scripts/e2e-lista-compartida.mjs`) en verde.

**Input**: Kevin, el 2026-10-27. Una instancia derivada de Vocero, con unas
decenas de miles de mensajes, tardaba de 6 a 13 s en pintar la Bandeja y su
Postgres estaba al 190 % de CPU. El arreglo ya corre en esa instancia; aquí se
porta al raíz, que tiene los mismos dos defectos.

**Carril**: ligero (Principio VI). Sin tabla, migración, variable ni contrato:
cambia cómo se consulta y cuántas veces se pide lo mismo, no qué se devuelve.

## Problema

1. **La vista previa no usaba el índice.** Cada renglón de la lista lleva el
   último mensaje de su conversación, sacado con una subconsulta que filtraba
   solo por `conversation_id`. El índice de `message` es
   `(organization_id, conversation_id, created_at)`: sin la primera columna
   Postgres no lo usa y recorre TODA la tabla por cada conversación.
2. **Cada mensaje pedía la lista cuatro veces por pestaña.** Un mensaje emite
   `message.new` y `conversation.updated`, y cada evento recargaba la lista
   completa dos veces: la Bandeja para pintarla y el menú para su contador de
   no leídos. Una ráfaga de diez mensajes eran ~40 peticiones de la consulta
   más cara de la app, por pestaña abierta.

## Comportamiento

- **LR-1 · La lista usa el índice.** La vista previa filtra por organización y
  conversación; `EXPLAIN ANALYZE` pasa de un seq scan de `message` por renglón
  a un index scan de `message_org_conv_idx`. La respuesta es idéntica.
- **LR-2 · Toda consulta de mensajes por conversación lleva la organización.**
  Las dos del Laboratorio (la transcripción para el juez y el sondeo de la
  respuesta) también; las demás ya la llevaban.
- **LR-3 · Una ráfaga es una recarga.** Con la Bandeja abierta, los eventos en
  vivo se juntan: lo que llega en 300 ms es una petición, nunca corren dos a la
  vez, y lo que llega mientras una va en camino agenda UNA más (no se pierde
  nada). Ráfaga de diez mensajes: de ~40 peticiones a 1–3.
- **LR-4 · El menú no pide su propia lista con la Bandeja abierta.** La
  Bandeja publica lo que trajo y el contador (y el aviso del sistema, que
  necesita el nombre del contacto) lo toma de ahí. Fuera de la Bandeja el menú
  sigue pidiendo la suya, también juntando ráfagas; al cerrar la Bandeja la
  vuelve a pedir para no quedarse con un número viejo.
- **LR-5 · Ctrl+K dentro de la Bandeja no pide la lista.** Usa la que la
  Bandeja mantiene al día. Fuera de la Bandeja la pide como antes.

## Criterios de aceptación (arnés `scripts/e2e-lista-compartida.mjs`)

1. Con la Bandeja abierta llegan diez mensajes: la lista enseña las diez
   conversaciones, la insignia del menú dice 10 y la pestaña pidió la lista a
   lo más 6 veces.
2. Ctrl+K en la Bandeja encuentra una conversación sin pedir la lista.
3. En Pipeline llegan cinco más: la insignia sube a 15 con a lo más 4
   peticiones.
4. De vuelta en la Bandeja: quince renglones, insignia en 15, sin errores de
   página.

## Decisiones

- **D1 — La lista compartida vive en la pestaña, no en un store.** Un módulo
  (`src/lib/lista-compartida.ts`) con eventos de `window`: la Bandeja y el
  menú están en ramas distintas del árbol (página y layout) y no comparten
  contexto de React. No se metió una dependencia de estado global por esto.
- **D2 — La lista solo se comparte mientras la Bandeja está montada.** Es la
  única que la mantiene al día con los eventos; cerrada, quien la necesite la
  pide.
- **D3 — Las recargas que dispara el operador no se juntan.** Enviar, eliminar
  o sembrar la demo siguen recargando al instante: el retraso
  de 300 ms solo vale para los eventos en vivo.

## Qué NO se hizo

- No se cambió el contrato SSE para mandar la conversación actualizada en el
  evento (evitaría la recarga por completo, pero toca un contrato publicado).
- No se paginó la lista ni se añadió índice nuevo: con el que ya existe basta.
- El seed de la demo borra contactos por teléfono sin acotar a la organización
  y se dejó igual: acotar solo sus mensajes rompería las llaves foráneas; es
  un arreglo aparte.
