# 032 — El seguimiento y el reintento respetan `ALLOWED_WA_IDS`

**Feature Branch**: `fix/032-seguimiento-permitidos` (solo `nea-agent`; esta
spec va en `docs/032-seguimiento-permitidos` de `vocero-crm`)

**Created**: 2026-10-20

**Status**: Especificada antes de escribir código.

**Input**: hallazgo de la prueba en vivo de la 031 en Coolify (bitácora del
2026-10-20): a las 16:23:42 UTC Nea le mandó el empujón de seguimiento a una
identidad que ya no estaba en `ALLOWED_WA_IDS`. El fallo ya estaba en `main`;
no es de la 031.

**Carril**: ligero (Principio VI). Arreglo de comportamiento dentro de Nea: no
cambia contratos (ni el despacho, ni `/api/bot/*`, ni `/api/brains/*`), ni el
esquema de la base, ni variables. Sin plan ni tareas aparte.

## Problema

`ALLOWED_WA_IDS` es el guardarraíl de las pruebas en vivo (Constitución V):
con valor, Nea solo le habla a esas identidades. Hoy solo lo respeta el turno
(gate 1 de `app/turn.py`). Los dos caminos que le escriben al lead **sin
turno** no lo miran:

1. **El seguimiento de 4 h** (`app/followup.py`) barre las conversaciones
   vencidas y manda el empujón a cualquiera.
2. **El reintento diferido de envíos** (`app/sender.py`) entrega lo que quedó
   en `pending_send` a cualquiera.

Así, quitar a alguien de la lista no lo saca de lo que Nea ya tenía en cola.

## Historia

**H1 — La lista manda en todo lo que Nea escribe.** Con `ALLOWED_WA_IDS` con
valor, ni el seguimiento ni el reintento le escriben a una identidad fuera de
la lista, aunque la conversación sea de antes de cambiarla. Con la lista
vacía, todo sigue como hoy (todos).

## Decisiones

**D1 — Misma regla que el turno.** Se compara `canonical_identity(identidad)`
contra `settings.allowed_identities`; lista vacía = sin restricción. Nada de
una segunda forma de leer la lista.

**D2 — Seguimiento fuera de la lista: se omite y queda consumido.** La
revisión va después del *claim*, así que `followup_sent` queda marcado y el
empujón no se reintenta en el barrido siguiente (a lo sumo uno, como siempre).
Si la identidad vuelve a la lista, ese empujón no sale; el siguiente turno
programa el suyo.

**D3 — Envío pendiente fuera de la lista: se abandona sin handoff.** Es un
silencio pedido por el operador, no una falla: no se alerta a un humano
(igual que el 409 del CRM). Tampoco se intenta enviar.

**D4 — De dónde sale la identidad del envío pendiente.** `pending_send` no la
guarda; se lee de su conversación (`bot_conversation.wa_identity`) al barrer
la cola (un `JOIN` en Postgres; en `MemoryStore`, de sus conversaciones). Sin
migración. Si con la lista puesta la identidad no se puede saber, se abandona
también: ante la duda, no se escribe.

## Constitution Check

| Principio | ¿Aplica? | Cómo |
|---|---|---|
| V — Guardarraíles de prueba | Sí, es el motivo | La lista cubre los tres caminos de salida |
| VI — Spec antes de código | Sí | Esta spec, carril ligero, antes del código |
| IX — Hecho = probado en vivo | Parcial | Ver «Verificación» |
| Contratos publicados | No cambian | Solo Nea por dentro |

## Criterios de aceptación

- Seguimiento con la lista puesta e identidad **dentro**: sale el empujón.
- Seguimiento con la lista puesta e identidad **fuera**: no sale nada y
  `followup_sent` queda en `true`; un segundo barrido tampoco envía.
- Seguimiento con la lista **vacía**: sale el empujón (como hoy).
- Envío pendiente con la lista puesta e identidad **dentro**: se entrega.
- Envío pendiente con la lista puesta e identidad **fuera**: no se intenta,
  queda `abandoned_at` y no hay handoff.
- Envío pendiente con la lista **vacía**: se entrega (como hoy).
- `pytest` de `nea-agent` en verde.

## Verificación

Unitarias en `tests/test_followup.py` y `tests/test_sender.py`. La prueba en
vivo exige dejar vencer un seguimiento de 4 h contra la línea de Kevin con la
lista cambiada: queda **pendiente de verificación humana** (o para la próxima
ronda en Coolify, con `FOLLOWUP_HOURS` bajo).
