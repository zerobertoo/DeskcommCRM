/**
 * Armazenamento em disco (lib/armazenamento/disco.ts) e a rota que o serve.
 * Cobre os três riscos do plano: assinatura adulterada, URL vencida e `..` no caminho.
 */
import { rmSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const raiz = vi.hoisted(() => `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/armazenamento-${process.pid}-${Date.now()}`);
vi.mock("@/lib/env", () => ({
  env: {
    STORAGE_DIR: raiz,
    PGRST_JWT_SECRET: "segredo-de-teste-com-pelo-menos-32-bytes!!",
    NEXT_PUBLIC_SUPABASE_URL: "https://crm.exemplo.com.br",
  },
}));

import { armazenamento } from "@/lib/armazenamento/disco";
import { GET } from "@/app/storage/v1/object/[modo]/[bucket]/[...caminho]/route";

afterAll(() => rmSync(raiz, { recursive: true, force: true }));

const bucket = () => armazenamento.from("whatsapp-media");
const ctx = (modo: string, b: string, caminho: string) => ({
  params: Promise.resolve({ modo, bucket: b, caminho: caminho.split("/") }),
});

describe("armazenamento em disco", () => {
  beforeEach(async () => {
    await bucket().remove(["org/a.txt", "org/b.txt"]);
  });

  it("sobe, baixa e remove, com o content-type guardado", async () => {
    const up = await bucket().upload("org/a.txt", Buffer.from("oi"), { contentType: "text/plain", upsert: false });
    expect(up.error).toBeNull();
    const dl = await bucket().download("org/a.txt");
    expect(await dl.data!.text()).toBe("oi");
    expect(dl.data!.type).toBe("text/plain");
    expect((await bucket().remove(["org/a.txt"])).data).toEqual([{ name: "org/a.txt" }]);
    expect((await bucket().download("org/a.txt")).error?.statusCode).toBe("404");
  });

  it("upsert:false em arquivo existente devolve 409 'already exists', como o Supabase", async () => {
    await bucket().upload("org/a.txt", Buffer.from("1"), { upsert: false });
    const de_novo = await bucket().upload("org/a.txt", Buffer.from("2"), { upsert: false });
    expect(de_novo.error).toMatchObject({ statusCode: "409", message: expect.stringMatching(/already exists/i) });
    expect((await bucket().upload("org/a.txt", Buffer.from("3"), { upsert: true })).error).toBeNull();
    expect(await (await bucket().download("org/a.txt")).data!.text()).toBe("3");
  });

  it("lista só o primeiro nível e copia entre buckets", async () => {
    await bucket().upload("org/a.txt", Buffer.from("x"), { contentType: "text/plain" });
    await bucket().upload("org/b.txt", Buffer.from("y"));
    expect((await bucket().list("org")).data!.map((e) => e.name)).toEqual(["a.txt", "b.txt"]);
    const copia = await bucket().copy("org/a.txt", "conv/a.txt", { destinationBucket: "propostas" });
    expect(copia.error).toBeNull();
    expect(await (await armazenamento.from("propostas").download("conv/a.txt")).data!.text()).toBe("x");
    await armazenamento.from("propostas").remove(["conv/a.txt"]);
  });

  it("`..`, barra invertida e NUL nunca saem do diretório do bucket", async () => {
    for (const ruim of ["../x", "a/../../x", "a\\b", "a\0b", "", "/"]) {
      expect((await bucket().upload(ruim, Buffer.from("x"))).error?.statusCode).toBe("400");
    }
  });
});

describe("rota /storage/v1/object", () => {
  async function urlAssinada(): Promise<URL> {
    await bucket().upload("org/a.txt", Buffer.from("segredo"), { contentType: "text/plain", upsert: true });
    return new URL((await bucket().createSignedUrl("org/a.txt", 60)).data!.signedUrl);
  }
  const pedir = (u: URL, modo = "sign") => GET(new Request(u), ctx(modo, "whatsapp-media", "org/a.txt"));

  it("a URL assinada serve o arquivo, sem cache compartilhado", async () => {
    const u = await urlAssinada();
    expect(u.pathname).toBe("/storage/v1/object/sign/whatsapp-media/org/a.txt");
    const res = await pedir(u);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("segredo");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("assinatura adulterada ou caminho trocado: 403", async () => {
    const u = await urlAssinada();
    const adulterada = new URL(u);
    adulterada.searchParams.set("sig", u.searchParams.get("sig")!.replace(/.$/, (c) => (c === "A" ? "B" : "A")));
    expect((await pedir(adulterada)).status).toBe(403);
    await bucket().upload("org/b.txt", Buffer.from("outro"), { upsert: true });
    const outro = await GET(new Request(u), ctx("sign", "whatsapp-media", "org/b.txt"));
    expect(outro.status).toBe(403);
  });

  it("URL vencida: 403", async () => {
    vi.useFakeTimers();
    try {
      const u = await urlAssinada();
      vi.setSystemTime(Date.now() + 61_000);
      expect((await pedir(u)).status).toBe(403);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sem assinatura, bucket privado: 403; bucket público de logos serve sem ela", async () => {
    expect((await GET(new Request("https://x/storage/v1/object/public/whatsapp-media/org/a.txt"), ctx("public", "whatsapp-media", "org/a.txt"))).status).toBe(403);
    await armazenamento.from("brand-logos").upload("o/l.png", Buffer.from("png"), { contentType: "image/png", upsert: true });
    const res = await GET(new Request("https://x/storage/v1/object/public/brand-logos/o/l.png"), ctx("public", "brand-logos", "o/l.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("`..` no caminho da rota: 400", async () => {
    const res = await GET(new Request("https://x/storage/v1/object/sign/whatsapp-media/a/..%2F..%2Fx"), ctx("sign", "whatsapp-media", "a/../../x"));
    expect(res.status).toBe(400);
  });
});
