/**
 * `useRealtimeChannel` sobre a conexão SSE compartilhada da aba, com um EventSource e um
 * fetch de mentira que o teste comanda.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeEventSource {
  static CLOSED = 2;
  static instancias: FakeEventSource[] = [];
  readyState = 1;
  onerror: (() => void) | null = null;
  fechado = false;
  private ouvintes = new Map<string, Array<(e: MessageEvent) => void>>();
  constructor(public url: string) {
    FakeEventSource.instancias.push(this);
  }
  addEventListener(nome: string, f: (e: MessageEvent) => void) {
    this.ouvintes.set(nome, [...(this.ouvintes.get(nome) ?? []), f]);
  }
  close() {
    this.fechado = true;
    this.readyState = 2;
  }
  emitir(nome: string, dados: unknown = {}) {
    for (const f of this.ouvintes.get(nome) ?? []) f({ data: JSON.stringify(dados) } as MessageEvent);
  }
}

const requisicoes: Array<{ metodo: string; url: string; corpo: Record<string, unknown> | null }> = [];
const ultima = () => FakeEventSource.instancias.at(-1)!;

async function carregar() {
  vi.resetModules(); // o módulo da conexão guarda estado de aba: cada teste começa do zero
  return (await import("@/hooks/realtime/useRealtimeChannel")).useRealtimeChannel;
}

beforeEach(() => {
  FakeEventSource.instancias = [];
  requisicoes.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requisicoes.push({ metodo: init?.method ?? "GET", url, corpo: init?.body ? JSON.parse(String(init.body)) : null });
      return { ok: true, status: 204 } as Response;
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const posts = () => requisicoes.filter((r) => r.metodo === "POST");

describe("useRealtimeChannel sobre a conexão SSE compartilhada", () => {
  it("vários hooks, UMA conexão; 'ready' registra cada assinatura e vira subscribed", async () => {
    const useRealtimeChannel = await carregar();
    const a = renderHook(() =>
      useRealtimeChannel({ name: "a", postgresChanges: { event: "*", table: "messages", filter: "conversation_id=eq.abc" }, onChange: () => undefined }),
    );
    const b = renderHook(() => useRealtimeChannel({ name: "tenant-health-1", broadcast: { event: "*" }, onChange: () => undefined }));
    expect(FakeEventSource.instancias).toHaveLength(1);
    expect(new URL(ultima().url, "http://x").pathname).toBe("/api/realtime");
    expect(a.result.current.status).toBe("connecting");

    act(() => ultima().emitir("ready"));
    expect(a.result.current.status).toBe("subscribed");
    expect(b.result.current.status).toBe("subscribed");
    expect(posts().map((p) => p.corpo)).toEqual([
      expect.objectContaining({ table: "messages", event: "*", filter: "conversation_id=eq.abc" }),
      expect.objectContaining({ channel: "tenant-health-1" }),
    ]);
  });

  it("roteia cada mudança só ao assinante dono do sid e carimba ultimaEntrega", async () => {
    const useRealtimeChannel = await carregar();
    const aMudou = vi.fn();
    const bMudou = vi.fn();
    const a = renderHook(() => useRealtimeChannel({ name: "a", postgresChanges: { event: "*", table: "messages" }, onChange: aMudou }));
    renderHook(() => useRealtimeChannel({ name: "b", postgresChanges: { event: "*", table: "conversations" }, onChange: bMudou }));
    act(() => ultima().emitir("ready"));
    const sidDeA = posts()[0]!.corpo!.sid;

    expect(a.result.current.ultimaEntrega.current).toBeNull();
    act(() => ultima().emitir("change", { sid: sidDeA, eventType: "INSERT", new: { id: "1" } }));
    expect(aMudou).toHaveBeenCalledWith({ eventType: "INSERT", new: { id: "1" } });
    expect(bMudou).not.toHaveBeenCalled();
    expect(a.result.current.ultimaEntrega.current).not.toBeNull();
  });

  it("a primeira assinatura não busca à toa; recusa do servidor recria o fluxo e entrega 'reassinado' uma vez", async () => {
    const useRealtimeChannel = await carregar();
    const onChange = vi.fn();
    renderHook(() => useRealtimeChannel({ name: "x", postgresChanges: { event: "*", table: "messages" }, onChange }));
    act(() => ultima().emitir("ready"));
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      ultima().readyState = FakeEventSource.CLOSED;
      ultima().onerror?.();
    });
    expect(FakeEventSource.instancias).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(1_000));
    expect(FakeEventSource.instancias).toHaveLength(2);

    act(() => ultima().emitir("ready"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ tipo: "reassinado" });
    expect(posts()).toHaveLength(2); // reassinou no servidor novo
  });

  it("a última assinatura cancelada fecha o fluxo e cancela a retomada pendente", async () => {
    const useRealtimeChannel = await carregar();
    const { unmount } = renderHook(() =>
      useRealtimeChannel({ name: "x", postgresChanges: { event: "*", table: "messages" }, onChange: () => undefined }),
    );
    act(() => ultima().emitir("ready"));
    act(() => {
      ultima().readyState = FakeEventSource.CLOSED;
      ultima().onerror?.();
    });
    unmount();
    act(() => void vi.advanceTimersByTime(60_000));
    expect(FakeEventSource.instancias).toHaveLength(1);
    expect(FakeEventSource.instancias[0]!.fechado).toBe(true);
  });

  it("desmontar um dos hooks cancela só a assinatura dele (DELETE) e mantém o fluxo", async () => {
    const useRealtimeChannel = await carregar();
    const a = renderHook(() => useRealtimeChannel({ name: "a", postgresChanges: { event: "*", table: "messages" }, onChange: () => undefined }));
    renderHook(() => useRealtimeChannel({ name: "b", postgresChanges: { event: "*", table: "conversations" }, onChange: () => undefined }));
    act(() => ultima().emitir("ready"));
    const sidDeA = posts()[0]!.corpo!.sid;
    a.unmount();
    expect(requisicoes.some((r) => r.metodo === "DELETE" && r.url.includes(`sid=${sidDeA}`))).toBe(true);
    expect(FakeEventSource.instancias[0]!.fechado).toBe(false);
  });

  it("enabled=false não abre fluxo nenhum", async () => {
    const useRealtimeChannel = await carregar();
    const { result } = renderHook(() =>
      useRealtimeChannel({ name: "x", postgresChanges: { event: "*", table: "messages" }, onChange: () => undefined, enabled: false }),
    );
    expect(FakeEventSource.instancias).toHaveLength(0);
    expect(result.current.status).toBe("closed");
  });
});
