# Guion E2E — Lista de conversaciones rápida (064)

> Automatizado en `scripts/e2e-lista-compartida.mjs`. Spec:
> [064](../../specs/064-lista-conversaciones-rapida/spec.md).

## Por qué

Cada mensaje recargaba la lista de conversaciones cuatro veces por pestaña, y
la consulta no usaba el índice: con decenas de miles de mensajes la Bandeja
tardaba segundos y la base se saturaba.

## Camino verificado

1. Se crea una cuenta con su número de pruebas y se abre la Bandeja.
2. Llegan diez mensajes de diez clientes: la lista los enseña, la insignia del
   menú dice 10 y la pestaña pidió la lista a lo más 6 veces (antes, ~40).
3. Ctrl+K dentro de la Bandeja encuentra a un cliente sin pedir la lista.
4. En Pipeline llegan cinco más: la insignia sube a 15 con a lo más 4
   peticiones (antes, ~10).
5. De vuelta en la Bandeja hay quince renglones, la insignia sigue en 15 y no
   hay errores de página.
