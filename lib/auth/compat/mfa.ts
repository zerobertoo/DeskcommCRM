/**
 * `supabase.auth.mfa.*` (TOTP) sobre `auth.mfa_factors`.
 *
 * Não usa o plugin `twoFactor` do Better Auth de propósito: ele segura a sessão
 * até o segundo fator, e o produto inteiro (proxy, `requirePlatformAdmin`, o
 * 403 `mfa_required`) é desenhado sobre sessão `aal1` que SOBE para `aal2`.
 * Aqui o login cria a sessão `aal1` e `verify` a promove — o mesmo contrato.
 */

import { randomUUID } from "node:crypto";
import { Secret, TOTP } from "otpauth";
import { poolDeAuth } from "@/lib/auth/better-auth";
import { erroCompat } from "@/lib/auth/compat/usuario";
import type { SessaoResolvida } from "@/lib/auth/compat/usuario-logado";

const SEM_SESSAO = () => erroCompat("Auth session missing!", 400, "session_missing");

function totpDe(segredoBase32: string, emissor: string, rotulo: string) {
  return new TOTP({ issuer: emissor, label: rotulo, algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(segredoBase32) });
}

export function criarMfaCompat(sessaoAtual: () => Promise<SessaoResolvida | null>) {
  async function fatores(userId: string) {
    const { rows } = await poolDeAuth().query<{ id: string; status: string; factor_type: string; friendly_name: string | null }>(
      "select id, status, factor_type, friendly_name from auth.mfa_factors where user_id = $1 order by created_at",
      [userId],
    );
    return rows;
  }

  return {
    async listFactors() {
      const s = await sessaoAtual();
      if (!s) return { data: null, error: SEM_SESSAO() };
      const all = await fatores(s.userId);
      return { data: { all, totp: all.filter((f) => f.factor_type === "totp" && f.status === "verified") }, error: null };
    },

    async enroll({ issuer, friendlyName }: { factorType: "totp"; issuer?: string; friendlyName?: string }) {
      const s = await sessaoAtual();
      if (!s) return { data: null, error: SEM_SESSAO() };
      const { rows: u } = await poolDeAuth().query<{ email: string }>("select email from auth.users where id = $1", [s.userId]);
      const segredo = new Secret({ size: 20 }).base32;
      const id = randomUUID();
      try {
        await poolDeAuth().query(
          "insert into auth.mfa_factors (id, user_id, status, factor_type, secret, friendly_name) values ($1, $2, 'unverified', 'totp', $3, $4)",
          [id, s.userId, segredo, friendlyName ?? null],
        );
      } catch (e) {
        if ((e as { code?: string }).code === "23505") {
          return { data: null, error: erroCompat(`A factor with the friendly name "${friendlyName}" already exists`, 422, "mfa_factor_name_conflict") };
        }
        throw e;
      }
      const totp = totpDe(segredo, issuer ?? "CRM", u[0]?.email ?? s.userId);
      return { data: { id, type: "totp" as const, totp: { qr_code: "", secret: segredo, uri: totp.toString() } }, error: null };
    },

    /** O desafio não guarda estado: o código é conferido contra o segredo em `verify`. */
    async challenge({ factorId }: { factorId: string }) {
      const s = await sessaoAtual();
      if (!s) return { data: null, error: SEM_SESSAO() };
      const f = (await fatores(s.userId)).find((x) => x.id === factorId);
      if (!f) return { data: null, error: erroCompat("MFA factor not found", 404, "mfa_factor_not_found") };
      return { data: { id: randomUUID(), type: "totp" as const, expires_at: Math.floor(Date.now() / 1000) + 300 }, error: null };
    },

    async verify({ factorId, code }: { factorId: string; challengeId?: string; code: string }) {
      const s = await sessaoAtual();
      if (!s) return { data: null, error: SEM_SESSAO() };
      const { rows } = await poolDeAuth().query<{ secret: string; email: string }>(
        `select f.secret, u.email from auth.mfa_factors f join auth.users u on u.id = f.user_id
         where f.id = $1 and f.user_id = $2 and f.factor_type = 'totp'`,
        [factorId, s.userId],
      );
      if (!rows[0]?.secret) return { data: null, error: erroCompat("MFA factor not found", 404, "mfa_factor_not_found") };
      // janela de ±1 passo (30 s) cobre o relógio do celular um pouco fora
      if (totpDe(rows[0].secret, "CRM", rows[0].email).validate({ token: code.replace(/\s/g, ""), window: 1 }) === null) {
        return { data: null, error: erroCompat("Invalid TOTP code entered", 422, "mfa_verification_failed") };
      }
      await poolDeAuth().query("update auth.mfa_factors set status = 'verified' where id = $1", [factorId]);
      await poolDeAuth().query("update auth.sessions set aal = 'aal2', updated_at = now() where id = $1", [s.sessionId]);
      return { data: { user: { id: s.userId } }, error: null };
    },

    async unenroll({ factorId }: { factorId: string }) {
      const s = await sessaoAtual();
      if (!s) return { data: null, error: SEM_SESSAO() };
      await poolDeAuth().query("delete from auth.mfa_factors where id = $1 and user_id = $2", [factorId, s.userId]);
      return { data: { id: factorId }, error: null };
    },

    async getAuthenticatorAssuranceLevel() {
      const s = await sessaoAtual();
      if (!s) return { data: null, error: SEM_SESSAO() };
      const temFator = (await fatores(s.userId)).some((f) => f.status === "verified");
      return {
        data: {
          currentLevel: s.aal,
          nextLevel: temFator ? ("aal2" as const) : s.aal,
          currentAuthenticationMethods: [],
        },
        error: null,
      };
    },
  };
}
