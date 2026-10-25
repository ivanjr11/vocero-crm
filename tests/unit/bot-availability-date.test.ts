import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarSettings } from "@/server/agenda/settings";

/**
 * `GET /api/bot/availability` con `date` (R10): lo que la ruta REGISTRA como
 * oferta y lo que contesta. El motor de huecos es el de verdad; solo se
 * sustituyen la BD, la llave y el reloj.
 *
 * El cerebro externo (Nea) lee `query.date` para saber si el CRM consultó el
 * día que pidió; si no vuelve, no afirma nada de ese día. Y solo puede
 * reservar lo que quedó registrado aquí (`POST /api/bot/bookings` compara por
 * epoch exacto contra la oferta vigente).
 */

const h = vi.hoisted(() => ({
  replaceOffers: vi.fn(async (..._args: unknown[]) => {}),
  computeCalls: [] as Array<{ fromISO?: string; toISO?: string }>,
  convRows: [{ id: "cv_1" }] as unknown[],
}));

const SETTINGS: CalendarSettings = {
  weeklyHours: {
    mon: [{ start: "10:00", end: "19:00" }],
    tue: [{ start: "10:00", end: "19:00" }],
    wed: [{ start: "10:00", end: "19:00" }],
    thu: [{ start: "10:00", end: "19:00" }],
    fri: [{ start: "10:00", end: "19:00" }],
  },
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeHours: 0,
  maxDaysAhead: 7,
  timezone: "America/Mexico_City",
  connector: "enlace-fijo",
  meetingLink: null,
  reminderMinutes: 0,
  reminderText: null,
  reminderTemplateId: null,
};

// Lunes 21 sep 2026, 09:00 CDMX.
const NOW = new Date("2026-09-21T15:00:00.000Z");

vi.mock("@/server/agenda/flag", () => ({
  agendaEnabled: () => true,
  agendaDisabledResponse: () => new Response(null, { status: 404 }),
}));

vi.mock("@/server/bot/auth", () => ({
  requireBotKey: () => null,
  resolveInstanceOrg: async () => "org_1",
}));

vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => h.convRows,
  };
  return { schema, getDb: () => chain };
});

vi.mock("@/server/agenda/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/agenda/settings")>()),
  getSettings: async () => SETTINGS,
}));

vi.mock("@/server/agenda/availability", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/agenda/availability")>();
  const { addDaysISO, todayInTz } = await import("@/lib/time/slots");
  return {
    ...real,
    // El motor real sin nada ocupado: horario semanal − aviso mínimo.
    computeAvailability: async (
      _org: string,
      opts: { fromISO?: string; toISO?: string; now: Date; settings: CalendarSettings }
    ) => {
      h.computeCalls.push({ fromISO: opts.fromISO, toISO: opts.toISO });
      const from = opts.fromISO ?? todayInTz(opts.now, SETTINGS.timezone);
      const to = opts.toISO ?? addDaysISO(from, SETTINGS.maxDaysAhead);
      return real.filterFreeSlots(real.buildCandidateSlots(SETTINGS, from, to), [], {
        now: opts.now,
        minNoticeHours: SETTINGS.minNoticeHours,
        timezone: SETTINGS.timezone,
      });
    },
  };
});

vi.mock("@/server/agenda/offers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/agenda/offers")>()),
  replaceOffers: h.replaceOffers,
}));

let GET: typeof import("@/app/api/bot/availability/route").GET;

// La ruta se importa una vez y fuera de los casos: su primer import carga
// medio servidor y, con la máquina ocupada, se comía los 5 s del primer caso
// (y el segundo caía en cascada con la oferta a medio registrar).
beforeAll(async () => {
  ({ GET } = await import("@/app/api/bot/availability/route"));
}, 60_000);

async function pedir(qs: string) {
  const res = await GET(new Request(`http://crm.test/api/bot/availability?${qs}`));
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {}
  return { status: res.status, json };
}

type Slot = { startUtc: string; label: string; dayIso: string; time: string };
const ofertaRegistrada = () =>
  (h.replaceOffers.mock.calls[0]?.[2] ?? []) as { startUtc: string; label: string }[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.replaceOffers.mockClear();
  h.computeCalls.length = 0;
  h.convRows = [{ id: "cv_1" }];
});

afterEach(() => {
  vi.useRealTimers();
});

const COMO_NEA = "conversationId=cv_1&limit=12&perDay=3&days=5";

describe("con date: la tarde de mañana, y reservable", () => {
  it("devuelve el día completo con query.date y lo registra como oferta", async () => {
    const { status, json } = await pedir(`${COMO_NEA}&date=2026-09-22`);
    expect(status).toBe(200);
    const slots = json!.slots as Slot[];
    expect(slots).toHaveLength(18);
    expect(slots.map((s) => s.time)).toEqual(
      expect.arrayContaining(["12:00", "15:00", "18:30"])
    );
    expect(json!.query).toEqual({
      date: "2026-09-22",
      status: "available",
      coveredUntil: "2026-09-22",
      horizonEnd: "2026-09-28",
      perDay: null,
    });
    expect(json!.diasConAgenda).toEqual(["2026-09-22"]);
    // Solo se calculó ese día.
    expect(h.computeCalls).toEqual([{ fromISO: "2026-09-22", toISO: "2026-09-22" }]);
    // Lo registrado es EXACTAMENTE lo devuelto: cualquiera de esas horas se
    // puede reservar después.
    expect(h.replaceOffers).toHaveBeenCalledOnce();
    expect(h.replaceOffers.mock.calls[0]!.slice(0, 2)).toEqual(["org_1", "cv_1"]);
    expect(ofertaRegistrada()).toEqual(
      slots.map((s) => ({ startUtc: s.startUtc, label: s.label }))
    );
  });

  it("un día cerrado dice por qué y NO borra la oferta vigente", async () => {
    const { status, json } = await pedir(`${COMO_NEA}&date=2026-09-26`);
    expect(status).toBe(200);
    expect(json!.slots).toEqual([]);
    expect(json!.query).toMatchObject({ date: "2026-09-26", status: "closed" });
    expect(h.replaceOffers).not.toHaveBeenCalled();
  });

  it.each([
    ["2026-09-20", "past"],
    ["2026-09-29", "beyond_horizon"],
  ])("%s → %s, sin calcular nada ni tocar la oferta", async (date, estado) => {
    const { status, json } = await pedir(`${COMO_NEA}&date=${date}`);
    expect(status).toBe(200);
    expect(json!.query).toMatchObject({ date, status: estado, horizonEnd: "2026-09-28" });
    expect(h.computeCalls).toEqual([]);
    expect(h.replaceOffers).not.toHaveBeenCalled();
  });
});

describe("fecha inválida", () => {
  it.each(["2026-02-31", "2026-13-01", "22-09-2026", "2026-9-22", "mañana", "2026-09-22T10:00"])(
    "%s → 422 invalid_body, nunca un 500 ni el reparto callado",
    async (date) => {
      const { status, json } = await pedir(`${COMO_NEA}&date=${encodeURIComponent(date)}`);
      expect(status).toBe(422);
      expect((json!.error as { code: string }).code).toBe("invalid_body");
      expect(h.computeCalls).toEqual([]);
      expect(h.replaceOffers).not.toHaveBeenCalled();
    }
  );

  it("date vacía cuenta como ausente: el reparto de siempre", async () => {
    const { status, json } = await pedir(`${COMO_NEA}&date=`);
    expect(status).toBe(200);
    expect((json!.query as { date: unknown }).date).toBeNull();
  });

  it("sin conversationId sigue siendo 422 (la sonda de Nea depende de eso)", async () => {
    const { status } = await pedir("date=2026-09-22");
    expect(status).toBe(422);
  });

  it("una conversación que no es de esta instancia → 404, sin oferta", async () => {
    h.convRows = [];
    const { status } = await pedir(`${COMO_NEA}&date=2026-09-22`);
    expect(status).toBe(404);
    expect(h.replaceOffers).not.toHaveBeenCalled();
  });
});

describe("sin date: la misma forma de siempre, más query", () => {
  it("slots + diasConAgenda como antes, y la cobertura en query", async () => {
    const { status, json } = await pedir(COMO_NEA);
    expect(status).toBe(200);
    expect(Object.keys(json!).sort()).toEqual(["diasConAgenda", "query", "slots"]);
    const slots = json!.slots as Slot[];
    expect(slots).toHaveLength(12);
    expect(Object.keys(slots[0]!).sort()).toEqual(
      ["dayIso", "dayLabel", "endUtc", "label", "startUtc", "time"]
    );
    expect(slots.filter((s) => s.dayIso === "2026-09-22").map((s) => s.time)).toEqual([
      "10:00",
      "10:30",
      "11:00",
    ]);
    expect(json!.diasConAgenda).toEqual([
      "2026-09-21",
      "2026-09-22",
      "2026-09-23",
      "2026-09-24",
    ]);
    expect(json!.query).toEqual({
      date: null,
      status: null,
      coveredUntil: "2026-09-24",
      horizonEnd: "2026-09-28",
      perDay: 3,
    });
    expect(ofertaRegistrada()).toHaveLength(12);
  });

  it("sin limit/perDay/days aplica los defaults del contrato (12/3/5), no 1", async () => {
    const { json } = await pedir("conversationId=cv_1");
    expect(json!.slots as Slot[]).toHaveLength(12);
    expect(json!.query).toMatchObject({ perDay: 3, coveredUntil: "2026-09-24" });
  });
});
