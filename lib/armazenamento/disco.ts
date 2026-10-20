/**
 * Armazenamento de arquivos em disco, com a MESMA forma do Storage do Supabase
 * (`storage.from(bucket).upload/download/remove/list/copy/createSignedUrl(s)`, sempre
 * `{ data, error }`), para a troca nos chamadores ser a de um único ponto: o
 * `createAdminClient` (lib/supabase/admin.ts).
 *
 * Layout: `<STORAGE_DIR>/<bucket>/<caminho>`; o content-type de cada arquivo mora
 * em `<STORAGE_DIR>/.meta/<bucket>/<caminho>`, fora do bucket para `list` não o ver.
 *
 * A URL assinada é `<NEXT_PUBLIC_SUPABASE_URL>/storage/v1/object/sign/<bucket>/<caminho>?exp=&sig=`
 * — o mesmo formato de antes, que `lib/messaging/media/url-de-midia-externa.ts` e
 * `lib/branding/logo.ts` já reconhecem. Quem serve é
 * `app/storage/v1/object/[modo]/[bucket]/[...caminho]/route.ts`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";

/** Buckets servidos sem assinatura (`/storage/v1/object/public/...`). */
export const BUCKETS_PUBLICOS: ReadonlySet<string> = new Set(["brand-logos"]);

type Erro = { message: string; statusCode: string };
const erro = (message: string, statusCode: string): Erro => ({ message, statusCode });

export function raizDoArmazenamento(): string {
  return env.STORAGE_DIR || path.join(process.cwd(), ".storage");
}

/**
 * Normaliza `caminho` dentro do bucket: sem `..`, sem segmento vazio, sem `\`
 * nem NUL. Devolve `null` quando o caminho tenta sair do diretório.
 */
export function caminhoSeguro(bucket: string, caminho: string): string | null {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(bucket)) return null;
  if (caminho.includes("\0") || caminho.includes("\\")) return null;
  const partes = caminho.split("/").filter((p) => p !== "");
  if (partes.length === 0 || partes.some((p) => p === "." || p === "..")) return null;
  return partes.join("/");
}

function arquivoDe(bucket: string, caminho: string): string {
  return path.join(raizDoArmazenamento(), bucket, ...caminho.split("/"));
}
function metaDe(bucket: string, caminho: string): string {
  return path.join(raizDoArmazenamento(), ".meta", bucket, ...caminho.split("/"));
}

function chaveDeAssinatura(): string {
  // o mesmo segredo do PostgREST: uma única coisa a proteger no .env
  return env.PGRST_JWT_SECRET;
}

function assinatura(bucket: string, caminho: string, exp: number): string {
  return createHmac("sha256", chaveDeAssinatura()).update(`storage\n${bucket}\n${caminho}\n${exp}`).digest("base64url");
}

/** `true` quando `sig` confere e `exp` (segundos unix) ainda não passou. */
export function assinaturaValida(bucket: string, caminho: string, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < Date.now() || !chaveDeAssinatura()) return false;
  const esperada = Buffer.from(assinatura(bucket, caminho, exp));
  const recebida = Buffer.from(sig);
  return esperada.length === recebida.length && timingSafeEqual(esperada, recebida);
}

function urlAssinada(bucket: string, caminho: string, segundos: number): string {
  const exp = Math.floor(Date.now() / 1000) + segundos;
  const base = env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, "");
  const alvo = caminho.split("/").map(encodeURIComponent).join("/");
  return `${base}/storage/v1/object/sign/${bucket}/${alvo}?exp=${exp}&sig=${assinatura(bucket, caminho, exp)}`;
}

/** Lê o arquivo e o content-type. `null` quando não existe. */
export async function lerArquivo(bucket: string, caminho: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  try {
    const bytes = await fs.readFile(arquivoDe(bucket, caminho));
    const contentType = await fs.readFile(metaDe(bucket, caminho), "utf8").catch(() => "application/octet-stream");
    return { bytes, contentType };
  } catch {
    return null;
  }
}

async function existe(arquivo: string): Promise<boolean> {
  return fs.access(arquivo).then(() => true, () => false);
}

async function gravar(bucket: string, caminho: string, bytes: Buffer, contentType: string, upsert: boolean) {
  const arquivo = arquivoDe(bucket, caminho);
  if (!upsert && (await existe(arquivo))) return erro("The resource already exists", "409");
  await fs.mkdir(path.dirname(arquivo), { recursive: true });
  await fs.writeFile(arquivo, bytes);
  const meta = metaDe(bucket, caminho);
  await fs.mkdir(path.dirname(meta), { recursive: true });
  await fs.writeFile(meta, contentType);
  return null;
}

async function paraBuffer(corpo: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(corpo)) return corpo;
  if (typeof corpo === "string") return Buffer.from(corpo, "utf8");
  if (corpo instanceof ArrayBuffer) return Buffer.from(corpo);
  if (ArrayBuffer.isView(corpo)) return Buffer.from(corpo.buffer, corpo.byteOffset, corpo.byteLength);
  if (typeof (corpo as Blob)?.arrayBuffer === "function") return Buffer.from(await (corpo as Blob).arrayBuffer());
  throw new Error("corpo de upload não suportado");
}

function bucketDoArmazenamento(bucket: string) {
  const recusa = erro("Invalid path", "400");

  return {
    async upload(caminho: string, corpo: unknown, opcoes: { contentType?: string; upsert?: boolean } = {}) {
      const c = caminhoSeguro(bucket, caminho);
      if (!c) return { data: null, error: recusa };
      const falha = await gravar(bucket, c, await paraBuffer(corpo), opcoes.contentType ?? "application/octet-stream", opcoes.upsert === true);
      return falha ? { data: null, error: falha } : { data: { path: c }, error: null };
    },

    async download(caminho: string) {
      const c = caminhoSeguro(bucket, caminho);
      if (!c) return { data: null, error: recusa };
      const lido = await lerArquivo(bucket, c);
      if (!lido) return { data: null, error: erro("Object not found", "404") };
      return { data: new Blob([new Uint8Array(lido.bytes)], { type: lido.contentType }), error: null };
    },

    async remove(caminhos: string[]) {
      const removidos: { name: string }[] = [];
      for (const caminho of caminhos) {
        const c = caminhoSeguro(bucket, caminho);
        if (!c) return { data: null, error: recusa };
        const existia = await existe(arquivoDe(bucket, c));
        await fs.rm(arquivoDe(bucket, c), { force: true });
        await fs.rm(metaDe(bucket, c), { force: true });
        if (existia) removidos.push({ name: c });
      }
      return { data: removidos, error: null };
    },

    async list(prefixo = "", opcoes: { limit?: number; offset?: number } = {}) {
      const c = prefixo === "" ? "" : caminhoSeguro(bucket, prefixo);
      if (c === null) return { data: null, error: recusa };
      const dir = path.join(raizDoArmazenamento(), bucket, ...c.split("/").filter(Boolean));
      const entradas = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      const itens = entradas
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(opcoes.offset ?? 0, (opcoes.offset ?? 0) + (opcoes.limit ?? 100))
        .map((e) => ({ name: e.name, id: e.isFile() ? `${c}/${e.name}` : null }));
      return { data: itens, error: null };
    },

    async createSignedUrl(caminho: string, segundos: number) {
      const c = caminhoSeguro(bucket, caminho);
      if (!c) return { data: null, error: recusa };
      if (!(await existe(arquivoDe(bucket, c)))) return { data: null, error: erro("Object not found", "404") };
      return { data: { signedUrl: urlAssinada(bucket, c, segundos) }, error: null };
    },

    async createSignedUrls(caminhos: string[], segundos: number) {
      const data = caminhos.map((caminho) => {
        const c = caminhoSeguro(bucket, caminho);
        return c
          ? { path: caminho, signedUrl: urlAssinada(bucket, c, segundos), error: null }
          : { path: caminho, signedUrl: null, error: "Invalid path" };
      });
      return { data, error: null };
    },

    async copy(origem: string, destino: string, opcoes: { destinationBucket?: string } = {}) {
      const de = caminhoSeguro(bucket, origem);
      const bucketDestino = opcoes.destinationBucket ?? bucket;
      const para = caminhoSeguro(bucketDestino, destino);
      if (!de || !para) return { data: null, error: recusa };
      const lido = await lerArquivo(bucket, de);
      if (!lido) return { data: null, error: erro("Object not found", "404") };
      const falha = await gravar(bucketDestino, para, lido.bytes, lido.contentType, false);
      return falha ? { data: null, error: falha } : { data: { path: para }, error: null };
    },
  };
}

/** O `supabase.storage`, sobre disco. */
export const armazenamento = { from: bucketDoArmazenamento };
