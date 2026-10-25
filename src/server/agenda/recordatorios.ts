import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { labelInTz, timeInTz } from "@/lib/time/slots";
import { agendaEnabled } from "@/server/agenda/flag";
import { DEFAULT_REMINDER_TEXT } from "@/server/agenda/settings";
import { SendError, sendText } from "@/server/inbox/send";
import { sendTemplate, TemplateError } from "@/server/whatsapp/templates";

/**
 * Recordatorio al cliente antes de su cita. Un barrido in-process, como el de
 * los webhooks: cada minuto busca las citas que entran en la ventana del
 * recordatorio (Ajustes → Agenda) y le escribe a cada cliente UNA vez.
 *
 * Dentro de la ventana de 24 h sale como texto libre; fuera de ella WhatsApp
 * solo admite plantillas, así que sale la plantilla aprobada que el negocio
 * eligió, o no sale (queda `omitido` en la cita, con el motivo).
 */

const INTERVALO_MS = 60_000;
const POR_TANDA = 20;

type Estado = { timer: NodeJS.Timeout | null; corriendo: boolean };

// En globalThis: en dev los módulos se evalúan más de una vez.
const g = globalThis as unknown as { __voceroRecordatorios?: Estado };

function estado(): Estado {
  if (!g.__voceroRecordatorios) {
    g.__voceroRecordatorios = { timer: null, corriendo: false };
  }
  return g.__voceroRecordatorios;
}

export function iniciarRecordatorios(): void {
  const e = estado();
  if (e.timer) return;
  e.timer = setInterval(() => void barridoRecordatorios(), INTERVALO_MS);
  e.timer.unref?.();
}

export function detenerRecordatorios(): void {
  const e = estado();
  if (e.timer) clearInterval(e.timer);
  e.timer = null;
}

/** `{nombre}`, `{hora}` y `{fecha}` del texto del negocio. */
export function textoDelRecordatorio(
  plantilla: string | null,
  datos: { nombre: string; startUtc: string; timezone: string }
): string {
  const nombre = datos.nombre.trim().split(/\s+/)[0] ?? "";
  const fecha = labelInTz(datos.startUtc, datos.timezone).split(",")[0] ?? "";
  return (plantilla || DEFAULT_REMINDER_TEXT)
    .replaceAll("{nombre}", nombre)
    .replaceAll("{hora}", timeInTz(datos.startUtc, datos.timezone))
    .replaceAll("{fecha}", fecha)
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

/**
 * Una pasada. Devuelve cuántas citas atendió (para las pruebas). Nunca lanza:
 * un fallo de una cita queda en ESA cita y el barrido sigue con la siguiente.
 */
export async function barridoRecordatorios(now: Date = new Date()): Promise<number> {
  if (!agendaEnabled()) return 0;
  const e = estado();
  if (e.corriendo) return 0;
  e.corriendo = true;
  try {
    const db = getDb();
    // Las columnas son `timestamp` sin zona, guardadas en UTC: el ISO sin su
    // «Z» es ese mismo instante. (Un Date crudo en `sql` no se serializa.)
    const ahora = sql`${now.toISOString()}::timestamp`;
    const pendientes = await db
      .select({
        booking: schema.booking,
        contactName: schema.contact.name,
        minutos: schema.calendarSettings.reminderMinutes,
        texto: schema.calendarSettings.reminderText,
        plantillaId: schema.calendarSettings.reminderTemplateId,
        timezone: schema.calendarSettings.timezone,
      })
      .from(schema.booking)
      .innerJoin(
        schema.calendarSettings,
        eq(schema.calendarSettings.organizationId, schema.booking.organizationId)
      )
      .innerJoin(schema.contact, eq(schema.contact.id, schema.booking.contactId))
      .where(
        and(
          eq(schema.booking.status, "agendada"),
          eq(schema.booking.kind, "session"),
          eq(schema.booking.isTest, false),
          isNull(schema.booking.reminderAt),
          isNotNull(schema.booking.conversationId),
          gt(schema.calendarSettings.reminderMinutes, 0),
          gt(schema.booking.scheduledAt, now),
          sql`${schema.booking.scheduledAt} <= ${ahora} + make_interval(mins => ${schema.calendarSettings.reminderMinutes})`,
          // Una cita reservada ya dentro de la ventana no se recuerda: el
          // cliente acaba de agendarla y un «te recuerdo» sería ruido.
          sql`${schema.booking.createdAt} <= ${schema.booking.scheduledAt} - make_interval(mins => ${schema.calendarSettings.reminderMinutes})`
        )
      )
      .limit(POR_TANDA);

    let atendidas = 0;
    for (const p of pendientes) {
      // La marca es la reserva: si otro barrido la tomó primero, no hay fila.
      const tomada = await db
        .update(schema.booking)
        .set({ reminderAt: now })
        .where(and(eq(schema.booking.id, p.booking.id), isNull(schema.booking.reminderAt)))
        .returning({ id: schema.booking.id });
      if (tomada.length === 0) continue;
      atendidas++;
      await recordar({
        bookingId: p.booking.id,
        organizationId: p.booking.organizationId,
        conversationId: p.booking.conversationId!,
        texto: textoDelRecordatorio(p.texto, {
          nombre: p.contactName,
          startUtc: p.booking.scheduledAt.toISOString(),
          timezone: p.timezone,
        }),
        plantillaId: p.plantillaId,
        hora: timeInTz(p.booking.scheduledAt.toISOString(), p.timezone),
        nombre: p.contactName.trim().split(/\s+/)[0] ?? "",
      });
    }
    return atendidas;
  } catch (err) {
    console.error(
      "[recordatorios] el barrido falló:",
      err instanceof Error ? err.message : err
    );
    return 0;
  } finally {
    e.corriendo = false;
  }
}

async function recordar(input: {
  bookingId: string;
  organizationId: string;
  conversationId: string;
  texto: string;
  plantillaId: string | null;
  hora: string;
  nombre: string;
}): Promise<void> {
  const db = getDb();
  const anotar = (
    reminderStatus: "enviado" | "plantilla" | "omitido" | "fallido",
    reminderError: string | null = null
  ) =>
    db
      .update(schema.booking)
      .set({ reminderStatus, reminderError })
      .where(eq(schema.booking.id, input.bookingId));

  try {
    await sendText({
      conversationId: input.conversationId,
      organizationId: input.organizationId,
      text: input.texto,
      aiGenerated: true,
    });
    await anotar("enviado");
    return;
  } catch (err) {
    if (!(err instanceof SendError) || err.code !== "window_closed") {
      await anotar("fallido", err instanceof Error ? err.message : "Error desconocido");
      return;
    }
  }

  // Ventana cerrada: solo una plantilla aprobada puede salir.
  if (!input.plantillaId) {
    await anotar(
      "omitido",
      "La ventana de 24 h estaba cerrada y no hay plantilla de recordatorio"
    );
    return;
  }
  try {
    // Las variables, en orden: {{1}} = nombre, {{2}} = hora. `sendTemplate`
    // toma solo las que la plantilla usa.
    await sendTemplate({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      templateId: input.plantillaId,
      variables: [input.nombre || "Hola", input.hora],
    });
    await anotar("plantilla");
  } catch (err) {
    await anotar(
      "fallido",
      err instanceof TemplateError || err instanceof Error ? err.message : "Error desconocido"
    );
  }
}
