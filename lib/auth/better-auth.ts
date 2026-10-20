/**
 * Better Auth sobre o schema `auth` do shim (scripts/selfhost-prelude.sql).
 *
 * Usuário e sessão moram em `auth.users` / `auth.sessions` — as tabelas a que as
 * policies RLS e as FKs do baseline já apontam —, então nada do schema muda. O
 * mapeamento camelCase → snake_case é a única ponte.
 *
 * A instância é preguiçosa: ler env e abrir o pool no import quebraria todo
 * teste que importa um módulo que importa este.
 */

import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins";
import { Pool } from "pg";
import { env } from "@/lib/env";
import { cookieSecure } from "@/lib/supabase/cookie-secure";

let pool: Pool | undefined;

/** Pool do Better Auth, também usado para ler o `aal` da sessão (lib/auth/sessao.ts). */
export function poolDeAuth(): Pool {
  return (pool ??= new Pool({
    connectionString: env.AUTH_DB_URL || env.SUPABASE_DB_URL,
    options: "-c search_path=auth,public",
    max: 5,
  }));
}

function criarAuth() {
  return betterAuth({
    database: poolDeAuth(),
    secret: env.PGRST_JWT_SECRET,
    baseURL: env.NEXT_PUBLIC_APP_URL,
    emailAndPassword: { enabled: true },
    advanced: {
      database: { generateId: "uuid" },
      cookiePrefix: "crm",
      useSecureCookies: cookieSecure(),
      defaultCookieAttributes: { sameSite: "strict", httpOnly: true },
    },
    user: {
      modelName: "users",
      fields: { emailVerified: "email_verified", createdAt: "created_at", updatedAt: "updated_at" },
    },
    session: {
      modelName: "sessions",
      fields: {
        userId: "user_id",
        expiresAt: "not_after",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    account: {
      modelName: "accounts",
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    verification: {
      modelName: "verifications",
      fields: { expiresAt: "expires_at", createdAt: "created_at", updatedAt: "updated_at" },
    },
    plugins: [
      admin({
        schema: {
          user: { fields: { banReason: "ban_reason", banExpires: "ban_expires" } },
          session: { fields: { impersonatedBy: "impersonated_by" } },
        },
      }),
      nextCookies(), // por último: grava o cookie em Server Actions
    ],
  });
}

let instancia: ReturnType<typeof criarAuth> | undefined;

/** A instância única do Better Auth (criada no primeiro uso). */
export function auth() {
  return (instancia ??= criarAuth());
}
