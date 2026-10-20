import { BUCKETS_PUBLICOS, assinaturaValida, caminhoSeguro, lerArquivo } from "@/lib/armazenamento/disco";

// Serve arquivos do armazenamento em disco no mesmo caminho que o Storage do
// Supabase usava. `sign`: só com `exp` e `sig` válidos (HMAC). `public`: só os
// buckets de BUCKETS_PUBLICOS. Rota pública no proxy: quem autoriza é a assinatura.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ modo: string; bucket: string; caminho: string[] }> },
) {
  const { modo, bucket, caminho: partes } = await params;
  const caminho = caminhoSeguro(bucket, partes.map(decodeURIComponent).join("/"));
  if (!caminho) return new Response("Invalid path", { status: 400 });

  if (modo === "public") {
    if (!BUCKETS_PUBLICOS.has(bucket)) return new Response("Forbidden", { status: 403 });
  } else if (modo === "sign") {
    const busca = new URL(request.url).searchParams;
    if (!assinaturaValida(bucket, caminho, Number(busca.get("exp")), busca.get("sig") ?? "")) {
      return new Response("Forbidden", { status: 403 });
    }
  } else {
    return new Response("Not found", { status: 404 });
  }

  const arquivo = await lerArquivo(bucket, caminho);
  if (!arquivo) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(arquivo.bytes), {
    headers: {
      "Content-Type": arquivo.contentType,
      "Content-Length": String(arquivo.bytes.length),
      "Cache-Control": modo === "public" ? "public, max-age=3600" : "private, no-store",
      "X-Content-Type-Options": "nosniff",
      // arquivos de usuário nunca executam script na origem do app
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
