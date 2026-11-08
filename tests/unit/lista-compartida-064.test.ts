import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unaALaVez } from "@/lib/lista-compartida";

/* 064 — Las recargas de la lista que llegan seguidas se juntan en una. */

describe("unaALaVez", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("diez llamadas seguidas son una sola petición", async () => {
    const fn = vi.fn(async () => "lista");
    const recargar = unaALaVez(fn, 300);
    const promesas = Array.from({ length: 10 }, () => recargar());
    await vi.advanceTimersByTimeAsync(300);
    expect(await Promise.all(promesas)).toEqual(Array(10).fill("lista"));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("lo que llega mientras pide agenda UNA más, no una por llamada", async () => {
    let soltar!: () => void;
    const fn = vi.fn(() => new Promise<number>((r) => { soltar = () => r(fn.mock.calls.length); }));
    const recargar = unaALaVez(fn, 300);
    const primera = recargar();
    await vi.advanceTimersByTimeAsync(300);
    expect(fn).toHaveBeenCalledTimes(1);
    // Ya está pidiendo: cinco eventos más.
    const otras = Array.from({ length: 5 }, () => recargar());
    soltar();
    expect(await primera).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    soltar();
    expect(new Set(await Promise.all(otras))).toEqual(new Set([2]));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("nunca corren dos a la vez", async () => {
    let enCurso = 0;
    let maximo = 0;
    const fn = vi.fn(async () => {
      enCurso++;
      maximo = Math.max(maximo, enCurso);
      await new Promise((r) => setTimeout(r, 1000));
      enCurso--;
    });
    const recargar = unaALaVez(fn, 100);
    for (let i = 0; i < 6; i++) {
      void recargar();
      await vi.advanceTimersByTimeAsync(250);
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(maximo).toBe(1);
    expect(fn.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("si una petición falla, la siguiente igual corre", async () => {
    const fn = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("red"))
      .mockResolvedValueOnce("ok");
    const recargar = unaALaVez(fn, 50);
    const primera = recargar().catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(50);
    expect(await primera).toBe("red");
    const segunda = recargar();
    await vi.advanceTimersByTimeAsync(50);
    expect(await segunda).toBe("ok");
  });
});

describe("la lista que publica la Bandeja", () => {
  beforeEach(() => vi.stubGlobal("window", new EventTarget()));
  afterEach(() => vi.unstubAllGlobals());

  const lista = [{ id: "cv_1", unreadCount: 2, contact: { name: "Ana", phone: null } }];

  it("solo vale mientras la Bandeja sigue abierta", async () => {
    const { marcarBandejaMontada, publicarLista, listaVigente, bandejaMontada } = await import(
      "@/lib/lista-compartida"
    );
    expect(listaVigente()).toBeNull();
    const cerrar = marcarBandejaMontada();
    expect(bandejaMontada()).toBe(true);
    expect(listaVigente()).toBeNull();
    publicarLista(lista);
    expect(listaVigente()).toEqual(lista);
    cerrar();
    expect(bandejaMontada()).toBe(false);
    expect(listaVigente()).toBeNull();
  });

  it("el menú recibe lo publicado y se entera cuando la Bandeja se cierra", async () => {
    const { marcarBandejaMontada, publicarLista, alPublicarLista, alDesmontarBandeja } = await import(
      "@/lib/lista-compartida"
    );
    const recibidas: unknown[] = [];
    const quitar = alPublicarLista((l) => recibidas.push(l));
    const desmontada = vi.fn();
    const quitarD = alDesmontarBandeja(desmontada);
    const cerrar = marcarBandejaMontada();
    publicarLista(lista);
    cerrar();
    expect(recibidas).toEqual([lista]);
    expect(desmontada).toHaveBeenCalledTimes(1);
    quitar();
    quitarD();
  });

  it("esperarLista se salta la que no sirve y toma la siguiente", async () => {
    const { publicarLista, esperarLista } = await import("@/lib/lista-compartida");
    const espera = esperarLista(1000, (l) => l.some((c) => c.id === "cv_1"));
    publicarLista([]);
    publicarLista(lista);
    expect(await espera).toEqual(lista);
  });
});
