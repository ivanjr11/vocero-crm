import { asc, desc, eq, gte, lt } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import type { DateRange } from "@/lib/time/calendar";
import { addDaysISO, partsInTz, zonedWallClockToUtc } from "@/lib/time/slots";
import { getSettings, type CalendarSettings } from "@/server/agenda/settings";

/** 015 — Listado de citas para la UI, con la hora en la zona del negocio. */

export type BookingListItem = {
  id: string;
  kind: "session" | "block";
  status: "agendada" | "realizada" | "no_show" | "cancelada";
  source: "manual" | "ai";
  scheduledAtUtc: string;
  durationMinutes: number;
  date: string;
  time: string;
  weekday: string;
  contact: { id: string; name: string } | null;
  conversationId: string | null;
  /** Con qué conector nació la entrega de esta cita. */
  connector: string | null;
  meetingLink: string | null;
  /** El proveedor falló al crear la reunión: se puede reintentar. */
  linkPending: boolean;
  isTest: boolean;
  notes: string | null;
  /** Cómo le fue al recordatorio al cliente (`null`: aún no toca o está apagado). */
  reminderStatus: "enviado" | "plantilla" | "omitido" | "fallido" | null;
  reminderError: string | null;
};

/** Tope del listado sin rango: el de siempre, que leen los guiones E2E. */
export const LIST_LIMIT = 200;

/**
 * 215 — Tope de una consulta por rango. No es un límite del producto (92 días
 * de un negocio con 30 citas diarias son 2 760): es el seguro contra una
 * respuesta de megas. Si se alcanza, la respuesta lo dice (`truncated`) en vez
 * de esconder citas como hacía el tope de 200.
 */
export const RANGE_LIMIT = 3000;

/**
 * Cuánto mira hacia atrás la consulta por rango. La API acepta bloqueos de
 * hasta 600 minutos: uno que empezó a las 20:00 del día anterior al rango
 * sigue ocupando su madrugada y la rejilla lo tiene que pintar.
 */
const LOOKBACK_MS = 24 * 3_600_000;

type Row = {
  booking: typeof schema.booking.$inferSelect;
  contactId: string | null;
  contactName: string | null;
};

function baseQuery() {
  return getDb()
    .select({
      booking: schema.booking,
      contactId: schema.contact.id,
      contactName: schema.contact.name,
    })
    .from(schema.booking)
    .leftJoin(schema.contact, eq(schema.booking.contactId, schema.contact.id));
}

/** Las últimas 200 citas: el listado de siempre, para quien no pide rango. */
export async function listBookings(
  organizationId: string,
  settings?: CalendarSettings
): Promise<BookingListItem[]> {
  const resolved = settings ?? (await getSettings(organizationId));
  const rows = await baseQuery()
    .where(scoped(schema.booking.organizationId, organizationId))
    .orderBy(desc(schema.booking.scheduledAt))
    .limit(LIST_LIMIT);
  return rows.map((r) => toListItem(r, resolved.timezone));
}

/**
 * 215 — Las citas que TOCAN un rango de días en la zona del negocio, en orden.
 *
 * `from`/`to` son fechas de calendario inclusivas; el corte se hace a la
 * medianoche del negocio, no a la de UTC (con cortes en UTC, lo que pasa
 * después de las 18:00 en México caería en la columna del día siguiente).
 */
export async function listBookingsInRange(
  organizationId: string,
  range: DateRange,
  settings?: CalendarSettings
): Promise<{ bookings: BookingListItem[]; truncated: boolean }> {
  const resolved = settings ?? (await getSettings(organizationId));
  const tz = resolved.timezone;
  // Fechas ya validadas (`parseRangeQuery`): la conversión no puede fallar.
  const start = zonedWallClockToUtc(range.from, "00:00", tz)!;
  const end = zonedWallClockToUtc(addDaysISO(range.to, 1), "00:00", tz)!;

  const rows = await baseQuery()
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        gte(schema.booking.scheduledAt, new Date(start.getTime() - LOOKBACK_MS)),
        lt(schema.booking.scheduledAt, end)
      )
    )
    .orderBy(asc(schema.booking.scheduledAt))
    .limit(RANGE_LIMIT);

  // De lo que empezó el día anterior, solo lo que sigue ocupando el rango.
  const inRange = rows.filter(
    (r) =>
      r.booking.scheduledAt.getTime() + r.booking.durationMinutes * 60_000 >
      start.getTime()
  );
  return {
    bookings: inRange.map((r) => toListItem(r, tz)),
    truncated: rows.length === RANGE_LIMIT,
  };
}

function toListItem(r: Row, timezone: string): BookingListItem {
  const scheduledAtUtc = r.booking.scheduledAt.toISOString();
  const parts = partsInTz(scheduledAtUtc, timezone);
  return {
    id: r.booking.id,
    kind: r.booking.kind,
    status: r.booking.status,
    source: r.booking.source,
    scheduledAtUtc,
    durationMinutes: r.booking.durationMinutes,
    date: parts.date,
    time: parts.time,
    weekday: parts.weekday,
    contact: r.contactId ? { id: r.contactId, name: r.contactName ?? "" } : null,
    conversationId: r.booking.conversationId,
    connector: r.booking.connector,
    meetingLink: r.booking.meetingLink,
    linkPending: r.booking.linkPending,
    isTest: r.booking.isTest,
    notes: r.booking.notes,
    reminderStatus: r.booking.reminderStatus,
    reminderError: r.booking.reminderError,
  };
}
