import jwt from "jsonwebtoken";
import request from "supertest";

import { aplicacao } from "@/app";
import { CENARIOS_OSCE } from "@/shared/constants/cenarios-osce";

// GEMINI_API_KEY nao e definida em jest.setup.js, entao o geminiClient real (nao
// mockado) fica null aqui — exatamente o caso que estas rotas precisam tratar como 503.
const CENARIO_ID = CENARIOS_OSCE[0].id;
const token = jwt.sign({ sub: "aluno-1", papel: "aluno", status: "ativo" }, "test-secret");

describe("rotas OSCE sem GEMINI_API_KEY configurada", () => {
  it("POST /:id/mensagem responde 503", async () => {
    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/mensagem`)
      .set("Authorization", `Bearer ${token}`)
      .send({ mensagem: "Bom dia." });

    expect(resposta.status).toBe(503);
    expect(resposta.body.erro.codigo).toBe("IA_INDISPONIVEL");
  });

  it("POST /:id/finalizar responde 503", async () => {
    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/finalizar`)
      .set("Authorization", `Bearer ${token}`)
      .send({ historico: [] });

    expect(resposta.status).toBe(503);
    expect(resposta.body.erro.codigo).toBe("IA_INDISPONIVEL");
  });
});
