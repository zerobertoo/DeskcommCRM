import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth/better-auth";

// Entrada, saída, MFA e demais fluxos do Better Auth. A instância é criada no
// primeiro pedido, não no import (o build não tem env de runtime).
export const GET = (req: Request) => toNextJsHandler(auth()).GET(req);
export const POST = (req: Request) => toNextJsHandler(auth()).POST(req);
