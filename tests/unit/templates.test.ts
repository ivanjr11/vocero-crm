import { describe, expect, it } from "vitest";
import {
  countVariables,
  importableTemplate,
  renderBody,
  validateBodyVariables,
} from "@/server/whatsapp/templates";

describe("countVariables / validateBodyVariables (FR-050)", () => {
  it("sin variables → 0, válido", () => {
    expect(countVariables("Hola, seguimos disponibles.")).toBe(0);
    expect(validateBodyVariables("Hola, seguimos disponibles.")).toBeNull();
  });

  it("una variable {{1}} → 1, válido (con y sin espacios)", () => {
    expect(countVariables("Hola {{1}}, ¿retomamos?")).toBe(1);
    expect(countVariables("Hola {{ 1 }}, ¿retomamos?")).toBe(1);
    expect(validateBodyVariables("Hola {{1}}, ¿retomamos?")).toBeNull();
  });

  it("varias variables numeradas en orden → válido", () => {
    const body = "Hola {{1}}, te confirmo el {{2}} a las {{3}}.";
    expect(countVariables(body)).toBe(3);
    expect(validateBodyVariables(body)).toBeNull();
  });

  it("la variable repetida cuenta una sola vez", () => {
    expect(countVariables("Hola {{1}}, ¿confirmas, {{1}}?")).toBe(1);
    expect(validateBodyVariables("Hola {{1}}, ¿confirmas, {{1}}?")).toBeNull();
  });

  it("numeración con salto → inválida", () => {
    expect(validateBodyVariables("Hola {{1}}, tu pedido {{3}} llegó")).toMatch(
      /sin saltos/
    );
  });

  it("variable {{2}} sola → inválida (debe empezar en {{1}})", () => {
    expect(validateBodyVariables("Tu pedido {{2}} llegó")).toMatch(/\{\{1\}\}/);
  });

  it("más de 10 variables → inválida", () => {
    const body = Array.from({ length: 11 }, (_, i) => `x {{${i + 1}}}`).join(" ");
    expect(validateBodyVariables(body)).toMatch(/hasta 10/);
  });
});

describe("renderBody", () => {
  it("sustituye la variable por el valor", () => {
    expect(renderBody("Hola {{1}}, ¿retomamos?", ["María"])).toBe(
      "Hola María, ¿retomamos?"
    );
  });

  it("sustituye cada variable por su posición", () => {
    expect(
      renderBody("Hola {{1}}, te espero el {{2}} a las {{3}}.", [
        "María",
        "12 de agosto",
        "5 pm",
      ])
    ).toBe("Hola María, te espero el 12 de agosto a las 5 pm.");
  });

  it("sin valores → variables vacías", () => {
    expect(renderBody("Hola {{1}}!")).toBe("Hola !");
    expect(renderBody("Hola {{1}} el {{2}}", ["María"])).toBe("Hola María el ");
  });
});

describe("importableTemplate (065, puerto de la spec 101: importar lo que ya está en Meta)", () => {
  const helloWorld = {
    id: "1234",
    name: "hello_world",
    language: "en_US",
    status: "APPROVED",
    category: "UTILITY",
    components: [
      { type: "HEADER", format: "TEXT", text: "Hello World" },
      { type: "BODY", text: "Welcome and congratulations!!" },
      { type: "FOOTER", text: "WhatsApp Business Platform sample message" },
    ],
  };

  it("hello_world se importa aprobada, con su cuerpo y su id de Meta", () => {
    expect(importableTemplate(helloWorld)).toEqual({
      name: "hello_world",
      language: "en_US",
      category: "UTILITY",
      body: "Welcome and congratulations!!",
      status: "approved",
      waTemplateId: "1234",
      rejectionReason: null,
    });
  });

  it("pendiente o rechazada también se importa, con su estado", () => {
    expect(importableTemplate({ ...helloWorld, status: "PENDING" })?.status).toBe("pending");
    expect(
      importableTemplate({ ...helloWorld, status: "REJECTED", rejected_reason: "INVALID_FORMAT" })
    ).toMatchObject({ status: "rejected", rejectionReason: "INVALID_FORMAT" });
  });

  it("botones fijos se aceptan", () => {
    expect(
      importableTemplate({
        ...helloWorld,
        components: [
          { type: "BODY", text: "Hola {{1}}" },
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Sí" },
              { type: "URL", url: "https://vocerocrm.com" },
            ],
          },
        ],
      })
    ).not.toBeNull();
  });

  it("lo que pide parámetros fuera del cuerpo NO se importa", () => {
    const con = (c: object) => ({
      ...helloWorld,
      components: [{ type: "BODY", text: "Hola" }, c],
    });
    expect(importableTemplate(con({ type: "HEADER", format: "IMAGE" }))).toBeNull();
    expect(importableTemplate(con({ type: "HEADER", format: "TEXT", text: "Hola {{1}}" }))).toBeNull();
    expect(
      importableTemplate(con({ type: "BUTTONS", buttons: [{ type: "URL", url: "https://x.com/{{1}}" }] }))
    ).toBeNull();
    expect(importableTemplate(con({ type: "BUTTONS", buttons: [{ type: "OTP" }] }))).toBeNull();
  });

  it("autenticación, sin cuerpo o con estado desconocido NO se importa", () => {
    expect(importableTemplate({ ...helloWorld, category: "AUTHENTICATION" })).toBeNull();
    expect(importableTemplate({ ...helloWorld, components: [] })).toBeNull();
    expect(importableTemplate({ ...helloWorld, status: "DISABLED" })).toBeNull();
  });
});
