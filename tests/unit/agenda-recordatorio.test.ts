import { describe, expect, it } from "vitest";
import { textoDelRecordatorio } from "@/server/agenda/recordatorios";
import { serializeBotProfile } from "@/server/bot/profile";
import type { schema } from "@/lib/db";

/** Recordatorio de la cita: el texto que recibe el cliente. */

const CITA = { nombre: "María Fernanda López", startUtc: "2026-10-25T20:00:00.000Z", timezone: "America/Lima" };

describe("textoDelRecordatorio", () => {
  it("sin texto propio sale el de ejemplo, con el primer nombre y la hora del negocio", () => {
    const texto = textoDelRecordatorio(null, CITA);
    expect(texto).toContain("Hola María 👋");
    expect(texto).toContain("15:00");
    expect(texto).not.toContain("{");
  });

  it("reemplaza {nombre}, {hora} y {fecha} en el texto del negocio", () => {
    const texto = textoDelRecordatorio("{nombre}, hablamos el {fecha} a las {hora}.", CITA);
    expect(texto.startsWith("María, hablamos el ")).toBe(true);
    expect(texto).toContain("a las 15:00.");
  });

  it("sin nombre no deja un espacio colgando antes de la coma", () => {
    expect(textoDelRecordatorio("Hola {nombre}, te espero a las {hora}", { ...CITA, nombre: "" })).toBe(
      "Hola, te espero a las 15:00"
    );
  });
});

describe("perfil del bot", () => {
  it("anuncia el recordatorio solo cuando se lo pasan", () => {
    const profile = { id: "ap_1", organizationId: "org_1", enabled: false, name: "José", tone: null, instructions: null, escalationRules: null, greeting: null, role: null, tools: null, welcomeMediaAssetId: null, createdAt: new Date(), updatedAt: new Date() } as unknown as typeof schema.agentProfile.$inferSelect;
    expect(serializeBotProfile(profile, []).appointmentReminder).toBeNull();
    expect(serializeBotProfile(profile, [], null, null, { minutesBefore: 30 }).appointmentReminder).toEqual({ minutesBefore: 30 });
  });
});
