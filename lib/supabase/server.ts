/**
 * Supabase client para Server Components, Route Handlers e Server Actions.
 *
 * Lê/escreve cookies via next/headers. Sempre use `getUser()` (valida JWT no
 * backend), NUNCA `getSession()` (confia no cookie local sem revalidar).
 */

import { headers } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { criarClienteDoUsuario } from "@/lib/supabase/cliente-do-usuario";

function clienteDeServidor(): SupabaseClient {
  return criarClienteDoUsuario(() => headers());
}

export async function createClient() {
  return clienteDeServidor();
}
