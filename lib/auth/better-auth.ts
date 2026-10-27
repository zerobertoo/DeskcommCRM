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
import { hashPassword } from "better-auth/crypto";
import { Pool } from "pg";
import { env } from "@/lib/env";
import { sessaoDireta } from "@/lib/auth/sessao-direta";
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
    emailAndPassword: { enabled: true, password: { hash: (senha) => hashPassword(senha) } },
    advanced: {
      database: { generateId: "uuid" },
      cookiePrefix: "crm",
      useSecureCookies: cookieSecure(),
      defaultCookieAttributes: { sameSite: "strict", httpOnly: true },
      // A volta do Google é navegação de outro site: cookie Strict não viaja e o
      // estado do OAuth se perderia (issue #1388). Só o estado é Lax; a sessão
      // segue Strict e chega ao app pela ponte /auth/google-ponte.
      cookies: {
        state: { attributes: { sameSite: "lax" } },
        oauth_state: { attributes: { sameSite: "lax" } },
      },
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
      // e-mail do Google é verificado: entra na conta que já existe com esse e-mail
      accountLinking: { enabled: true, trustedProviders: ["google"] },
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
    socialProviders: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
      : {},
    plugins: [
      admin({
        schema: {
          user: { fields: { banReason: "ban_reason", banExpires: "ban_expires" } },
          session: { fields: { impersonatedBy: "impersonated_by" } },
        },
      }),
      sessaoDireta(),
      nextCookies(), // por último: grava o cookie em Server Actions
    ],
  });
}

let instancia: ReturnType<typeof criarAuth> | undefined;

/** A instância única do Better Auth (criada no primeiro uso). */
export function auth() {
  return (instancia ??= criarAuth());
}
