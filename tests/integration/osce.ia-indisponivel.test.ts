import jwt from "jsonwebtoken";
import request from "supertest";

import { aplicacao } from "@/app";
import { CENARIOS_OSCE } from "@/shared/constants/cenarios-osce";

// GEMINI_API_KEY nao e definida em jest.setup.js, entao o geminiClient real (nao
// mockado) fica null aqui — exatamente o caso que estas rotas precisam tratar como 503.
const CENARIO_ID = CENARIOS_OSCE[0].id;
const token = jwt.sign({ sub: "aluno-1", papel: "aluno", status: "ativo" }, "test-secret");
const tokenProfessor = jwt.sign(
  { sub: "professor-1", papel: "PROFESSOR", status: "ATIVO" },
  "test-secret",
);
// Mesmo default de teste de INTERNAL_TOKEN (ver obrigatoriaComDefaultDeTeste em config/env.ts).
const TOKEN_INTERNO = "test-internal-token";

describe("rotas OSCE sem GEMINI_API_KEY configurada", () => {
  it("POST /:id/mensagem responde 503", async () => {
    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/mensagem`)
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`)
      .send({ mensagem: "Bom dia." });

    expect(resposta.status).toBe(503);
    expect(resposta.body.erro.codigo).toBe("IA_INDISPONIVEL");
  });

  it("POST /:id/finalizar responde 503", async () => {
    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/finalizar`)
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`)
      .send({ historico: [] });

    expect(resposta.status).toBe(503);
    expect(resposta.body.erro.codigo).toBe("IA_INDISPONIVEL");
  });

  it("POST /melhorar-texto responde 503", async () => {
    const resposta = await request(aplicacao)
      .post("/osce/melhorar-texto")
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${tokenProfessor}`)
      .send({ campo: "titulo", texto: "Paciente com dor no peito" });

    expect(resposta.status).toBe(503);
    expect(resposta.body.erro.codigo).toBe("IA_INDISPONIVEL");
  });
});
