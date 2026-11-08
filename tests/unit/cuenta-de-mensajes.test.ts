import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 065 — El split de 2026: la Cuenta de WhatsApp (el número) y la Cuenta de
 * mensajes (plantillas y pago). Aquí se habla con el cliente real
 * (`graphRequest`) sobre un `fetch` falso, para ver a qué cuenta va cada
 * llamada:
 *
 *   - el webhook se registra también en la cuenta de mensajes, con las
 *     mismas reglas de respeto que la de WhatsApp;
 *   - las plantillas se crean y se sincronizan en la cuenta de mensajes;
 *   - el `2388339` sin cuenta de mensajes dice qué hacer;
 *   - el sync importa lo que ya existe en Meta (puerto de la spec 101).
 */

const env = vi.hoisted(() => ({
  APP_BASE_URL: "https://crm.ejemplo.test",
  META_WEBHOOK_VERIFY_TOKEN: "verify-token-xyz",
  META_GRAPH_BASE_URL: "https://graph.facebook.com",
  META_GRAPH_API_VERSION: "v25.0",
}));
vi.mock("@/lib/env", () => ({ getEnv: () => env }));

const creds = vi.hoisted(() => ({
  current: null as null | {
    id: string;
    organizationId: string;
    wabaId: string;
    messagingAccountId: string | null;
    phoneNumberId: string;
    displayPhoneNumber: string | null;
    verifiedName: string | null;
    status: "connected" | "reconnect_required";
    token: string;
  },
}));
vi.mock("@/server/whatsapp/credentials", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/whatsapp/credentials")>();
  return {
    cuentaDePlantillas: real.cuentaDePlantillas,
    getCredentialsByOrg: async () => creds.current,
    getCredentialsByWabaId: async () => creds.current,
    markReconnectRequired: vi.fn(async () => {}),
  };
});
vi.mock("@/server/events/bus", () => ({ publish: () => {} }));
vi.mock("@/server/inbox/send", () => ({
  callGraphSend: vi.fn(),
  SendError: class SendError extends Error {},
}));
vi.mock("@/server/inbox/ingest", () => ({ serializeMessage: (m: unknown) => m }));

/** Base de datos de mentira: lo justo para crear y sincronizar plantillas. */
const db = vi.hoisted(() => ({
  local: [] as Record<string, unknown>[],
  insertados: [] as Record<string, unknown>[],
  actualizados: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: async () => db.local }) }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        db.insertados.push(v);
        const filas = async () => [{ ...v }];
        return {
          onConflictDoUpdate: () => ({ returning: filas }),
          onConflictDoNothing: () => ({ returning: filas }),
        };
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          db.actualizados.push(v);
        },
      }),
    }),
  }),
  schema: {
    template: { id: "id", organizationId: "organization_id", name: "name", language: "language" },
  },
}));

import {
  descubrirCuentaDeMensajes,
  registerWebhookForNumber,
  unregisterWebhookForMessagingAccount,
} from "@/server/whatsapp/connect";
import { cuentaDePlantillas } from "@/server/whatsapp/credentials";
import { createTemplate, syncTemplates, TemplateError } from "@/server/whatsapp/templates";

const URL_PROPIA = "https://crm.ejemplo.test/api/webhooks/wa/verify-token-xyz";
const RUTA_PROPIA = "/api/webhooks/wa/verify-token-xyz";
const G = "https://graph.facebook.com/v25.0";

const fetchMock = vi.fn();
const respond = (data: unknown, status = 200) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(data), { status }));
const metaError = (status: number, code: number, extra: Record<string, unknown> = {}) =>
  respond({ error: { message: "error de Meta", code, type: "OAuthException", ...extra } }, status);
const call = (i: number) => {
  const [url, init] = fetchMock.mock.calls[i]! as [string, RequestInit];
  return {
    url,
    method: init.method,
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  };
};

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  db.local = [];
  db.insertados = [];
  db.actualizados = [];
  creds.current = {
    id: "cred_1",
    organizationId: "org_1",
    wabaId: "111",
    messagingAccountId: "333",
    phoneNumberId: "222",
    displayPhoneNumber: null,
    verifiedName: null,
    status: "connected",
    token: "EAAG-token",
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("qué cuenta tiene las plantillas", () => {
  it("la de mensajes si se conoce; si no, la de WhatsApp", () => {
    expect(cuentaDePlantillas({ wabaId: "111", messagingAccountId: "333" })).toBe("333");
    expect(cuentaDePlantillas({ wabaId: "111", messagingAccountId: null })).toBe("111");
    expect(cuentaDePlantillas({ wabaId: "111", messagingAccountId: "" })).toBe("111");
  });
});

describe("registro del webhook en la Cuenta de mensajes", () => {
  const opts = {
    wabaId: "111",
    phoneNumberId: "222",
    token: "EAAG-token",
    webhookUrl: URL_PROPIA,
    verifyToken: "verify-token-xyz",
    messagingAccountId: "333",
  };
  const sinOverride = () => respond({ data: [{ whatsapp_business_api_data: { id: "app-1" } }] });
  const conOverride = (uri: string) =>
    respond({ data: [{ whatsapp_business_api_data: { id: "app-1" }, override_callback_uri: uri }] });
  const numeroConfirmado = () =>
    respond({ webhook_configuration: { phone_number: URL_PROPIA, application: "https://app.test/wh" } });

  it("suscribe la app con override en la cuenta de mensajes y lo confirma releyendo", async () => {
    sinOverride(); // GET 111/subscribed_apps
    respond({ success: true }); // POST 111/subscribed_apps
    sinOverride(); // GET 333/subscribed_apps — solo la app interna de Meta
    respond({ success: true }); // POST 333/subscribed_apps con override
    conOverride(URL_PROPIA); // GET 333/subscribed_apps — confirmado
    respond({ success: true }); // POST 222 override del número
    numeroConfirmado();

    expect(await registerWebhookForNumber(opts)).toEqual({
      ok: true,
      appWithoutWebhook: false,
      messagingAccount: { ok: true },
    });
    expect(call(2)).toMatchObject({ url: `${G}/333/subscribed_apps`, method: "GET" });
    expect(call(3)).toMatchObject({
      url: `${G}/333/subscribed_apps`,
      method: "POST",
      body: { override_callback_uri: URL_PROPIA, verify_token: "verify-token-xyz" },
    });
    expect(call(4)).toMatchObject({ url: `${G}/333/subscribed_apps`, method: "GET" });
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("si ya tiene el override de esta instancia (aunque cambie el dominio), no lo toca", async () => {
    sinOverride();
    respond({ success: true });
    conOverride(`https://dominio-viejo.test${RUTA_PROPIA}`);
    respond({ success: true });
    numeroConfirmado();

    const res = await registerWebhookForNumber(opts);
    expect(res).toMatchObject({ ok: true, messagingAccount: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(call(3).url).toBe(`${G}/222`);
  });

  it("un override ajeno se respeta y se informa; con «Recuperar» se reemplaza", async () => {
    sinOverride();
    respond({ success: true });
    conOverride("https://cerebro-ajeno.test/hook/secreto");
    respond({ success: true });
    numeroConfirmado();
    expect(await registerWebhookForNumber(opts)).toMatchObject({
      ok: true,
      messagingAccount: { ok: true, skipped: "override_ajeno", host: "cerebro-ajeno.test" },
    });

    fetchMock.mockReset();
    sinOverride();
    respond({ success: true });
    conOverride("https://cerebro-ajeno.test/hook/secreto");
    respond({ success: true });
    conOverride(URL_PROPIA);
    respond({ success: true });
    numeroConfirmado();
    expect(await registerWebhookForNumber({ ...opts, forzar: true })).toMatchObject({
      ok: true,
      messagingAccount: { ok: true },
    });
    expect(call(3)).toMatchObject({ url: `${G}/333/subscribed_apps`, method: "POST" });
  });

  it("si Meta niega el permiso en la cuenta de mensajes, el número queda igual y se explica", async () => {
    sinOverride();
    respond({ success: true });
    sinOverride();
    metaError(403, 200);
    respond({ success: true });
    numeroConfirmado();

    const res = await registerWebhookForNumber(opts);
    expect(res).toMatchObject({
      ok: true,
      appWithoutWebhook: false,
      messagingAccount: { ok: false, code: "missing_permission" },
    });
    if (res.ok && "messagingAccount" in res && res.messagingAccount && !res.messagingAccount.ok) {
      expect(res.messagingAccount.message).toContain("Messaging accounts");
    }
  });

  it("si no lo confirma al releer, avisa sin tumbar el número", async () => {
    sinOverride();
    respond({ success: true });
    sinOverride();
    respond({ success: true });
    sinOverride();
    respond({ success: true });
    numeroConfirmado();
    expect(await registerWebhookForNumber(opts)).toMatchObject({
      ok: true,
      messagingAccount: { ok: false, code: "meta_error" },
    });
  });

  it("sin cuenta de mensajes —o si es la misma que la guardada como WABA— no hay llamadas extra", async () => {
    for (const messagingAccountId of [null, "111"]) {
      fetchMock.mockReset();
      sinOverride();
      respond({ success: true });
      respond({ success: true });
      numeroConfirmado();
      expect(await registerWebhookForNumber({ ...opts, messagingAccountId })).toEqual({
        ok: true,
        appWithoutWebhook: false,
      });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    }
  });

  it("si la cuenta de WhatsApp enruta a un override ajeno, la de mensajes tampoco se toca", async () => {
    conOverride("https://agencia.test/hook");
    respond({ webhook_configuration: {} }); // baja del número: no era nuestro
    expect(await registerWebhookForNumber(opts)).toEqual({
      ok: true,
      skipped: "waba_override",
      host: "agencia.test",
    });
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/333/"))).toBe(false);
  });

  // 066 — Desde la noche del 28-oct-2026 Meta también rechaza la suscripción
  // en la cuenta de WhatsApp partida; lo que cuenta es la de mensajes.
  const cuentaPartida = () => metaError(400, 100, { error_subcode: 2388339 });

  it("2388339 en la cuenta de WhatsApp no es fatal si la de mensajes quedó (066)", async () => {
    sinOverride(); // GET 111
    cuentaPartida(); // POST 111 → 2388339
    sinOverride(); // GET 333
    respond({ success: true }); // POST 333 con override
    conOverride(URL_PROPIA); // GET 333 confirmado
    respond({ success: true }); // POST 222 override del número
    numeroConfirmado();
    expect(await registerWebhookForNumber(opts)).toEqual({
      ok: true,
      appWithoutWebhook: false,
      messagingAccount: { ok: true },
    });
    expect(call(5)).toMatchObject({ url: `${G}/222`, method: "POST" });
  });

  it("2388339 con la de mensajes fallando devuelve ese error, y sin ella pide la ID (066)", async () => {
    sinOverride();
    cuentaPartida();
    sinOverride();
    metaError(403, 200);
    expect(await registerWebhookForNumber(opts)).toMatchObject({
      ok: false,
      code: "missing_permission",
    });
    expect(fetchMock.mock.calls.some(([u]) => String(u) === `${G}/222`)).toBe(false);

    fetchMock.mockReset();
    sinOverride();
    cuentaPartida();
    const sinCuenta = await registerWebhookForNumber({ ...opts, messagingAccountId: null });
    expect(sinCuenta).toMatchObject({ ok: false, code: "meta_error" });
    expect(!sinCuenta.ok && sinCuenta.message).toContain("Cuenta de mensajes");
  });

  it("otro error de la cuenta de WhatsApp sigue siendo fatal aunque haya cuenta de mensajes", async () => {
    sinOverride();
    metaError(403, 200);
    expect(await registerWebhookForNumber(opts)).toMatchObject({ ok: false, code: "missing_permission" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("al desconectar, la cuenta de mensajes", () => {
  const baja = { messagingAccountId: "333", token: "EAAG-token", webhookPath: RUTA_PROPIA };

  it("se le quita el override si es nuestro (POST sin cuerpo)", async () => {
    respond({ data: [{ override_callback_uri: URL_PROPIA }] });
    respond({ success: true });
    await unregisterWebhookForMessagingAccount(baja);
    expect(call(1)).toMatchObject({ url: `${G}/333/subscribed_apps`, method: "POST", body: undefined });
  });

  it("uno ajeno no se toca y un error de Meta no lanza", async () => {
    respond({ data: [{ override_callback_uri: "https://otro.test/hook" }] });
    await unregisterWebhookForMessagingAccount(baja);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    metaError(500, 2);
    await expect(unregisterWebhookForMessagingAccount(baja)).resolves.toBeUndefined();
  });
});

describe("descubrir la cuenta de mensajes (best-effort)", () => {
  it("lee paid_messaging_account_id como cadena o como objeto", async () => {
    respond({ paid_messaging_account_id: "333", id: "111" });
    expect(await descubrirCuentaDeMensajes("111", "EAAG-token")).toBe("333");
    expect(call(0).url).toBe(`${G}/111?fields=paid_messaging_account_id`);
    respond({ paid_messaging_account_id: { id: "444" } });
    expect(await descubrirCuentaDeMensajes("111", "EAAG-token")).toBe("444");
  });

  it("campo desconocido, vacío, raro o igual a la WABA → null, sin lanzar", async () => {
    metaError(400, 100);
    expect(await descubrirCuentaDeMensajes("111", "t")).toBeNull();
    respond({ id: "111" });
    expect(await descubrirCuentaDeMensajes("111", "t")).toBeNull();
    respond({ paid_messaging_account_id: "no-numérico" });
    expect(await descubrirCuentaDeMensajes("111", "t")).toBeNull();
    respond({ paid_messaging_account_id: "111" });
    expect(await descubrirCuentaDeMensajes("111", "t")).toBeNull();
  });
});

describe("crear plantillas", () => {
  const nueva = { name: "Aviso pedido", language: "es_MX", category: "UTILITY", body: "Hola {{1}}" };

  it("con cuenta de mensajes, el POST va a ella", async () => {
    respond({ id: "tpl_1", status: "PENDING" });
    await createTemplate("org_1", nueva);
    expect(call(0)).toMatchObject({ url: `${G}/333/message_templates`, method: "POST" });
    expect(db.insertados[0]).toMatchObject({ name: "aviso_pedido", waTemplateId: "tpl_1" });
  });

  it("sin ella, va a la de WhatsApp como antes", async () => {
    creds.current!.messagingAccountId = null;
    respond({ id: "tpl_1", status: "PENDING" });
    await createTemplate("org_1", nueva);
    expect(call(0).url).toBe(`${G}/111/message_templates`);
  });

  it("sin ella y con el 2388339 de Meta, el error dice dónde poner la Cuenta de mensajes", async () => {
    creds.current!.messagingAccountId = null;
    metaError(400, 100, {
      error_subcode: 2388339,
      message: "Invalid parameter",
      error_user_msg: "This API is not supported for this WhatsApp Business Account",
    });
    const err = await createTemplate("org_1", nueva).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TemplateError);
    expect((err as TemplateError).code).toBe("meta_error");
    expect((err as TemplateError).message).toContain("Cuenta de mensajes");
    expect((err as TemplateError).message).toContain("Ajustes → WhatsApp");
    expect(db.insertados).toHaveLength(0);
  });

  it("otros errores de Meta conservan su mensaje", async () => {
    metaError(400, 100, { message: "Invalid parameter" });
    await expect(createTemplate("org_1", nueva)).rejects.toMatchObject({
      code: "meta_error",
      message: "Invalid parameter",
    });
  });
});

describe("sincronizar plantillas", () => {
  const helloWorld = {
    id: "hw_1",
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

  it("lee la cuenta de mensajes con components y recorre la paginación", async () => {
    respond({ data: [helloWorld], paging: { cursors: { after: "CUR" }, next: "https://graph/next" } });
    respond({ data: [], paging: { cursors: { after: "FIN" } } });
    await syncTemplates("org_1");
    expect(call(0).url).toBe(
      `${G}/333/message_templates?fields=id,name,language,status,category,rejected_reason,components&limit=100`
    );
    expect(call(1).url).toContain("&after=CUR");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("trae TODAS las páginas (más de 20) y las importa todas", async () => {
    for (let i = 0; i < 25; i += 1) {
      respond({
        data: [{ ...helloWorld, id: `t_${i}`, name: `plantilla_${i}` }],
        paging: i < 24 ? { cursors: { after: `C${i}` }, next: "https://graph/next" } : {},
      });
    }
    expect(await syncTemplates("org_1")).toBe(25);
    expect(fetchMock).toHaveBeenCalledTimes(25);
    expect(db.insertados.map((f) => f.name)).toContain("plantilla_24");
  });

  it("si Meta repite el cursor, se detiene en vez de dar vueltas", async () => {
    respond({ data: [helloWorld], paging: { cursors: { after: "MISMO" }, next: "https://graph/next" } });
    respond({ data: [], paging: { cursors: { after: "MISMO" }, next: "https://graph/next" } });
    await syncTemplates("org_1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("importa hello_world aprobada y deja fuera la de encabezado con imagen", async () => {
    respond({
      data: [
        helloWorld,
        {
          ...helloWorld,
          id: "img_1",
          name: "promo_imagen",
          components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hola" }],
        },
      ],
    });
    expect(await syncTemplates("org_1")).toBe(1);
    expect(db.insertados).toHaveLength(1);
    expect(db.insertados[0]).toMatchObject({
      organizationId: "org_1",
      name: "hello_world",
      language: "en_US",
      status: "approved",
      waTemplateId: "hw_1",
      body: "Welcome and congratulations!!",
    });
  });

  it("lo que ya existe sigue el camino de siempre (estado y categoría), sin importar de nuevo", async () => {
    db.local = [
      {
        id: "tpl_local",
        name: "hello_world",
        language: "en_US",
        status: "pending",
        category: "UTILITY",
        waTemplateId: null,
      },
    ];
    respond({ data: [helloWorld] });
    expect(await syncTemplates("org_1")).toBe(1);
    expect(db.insertados).toHaveLength(0);
    expect(db.actualizados[0]).toMatchObject({ status: "approved", waTemplateId: "hw_1" });
  });

  it("sin cuenta de mensajes, lee la de WhatsApp", async () => {
    creds.current!.messagingAccountId = null;
    respond({ data: [] });
    await syncTemplates("org_1");
    expect(call(0).url).toContain(`${G}/111/message_templates?`);
  });
});
