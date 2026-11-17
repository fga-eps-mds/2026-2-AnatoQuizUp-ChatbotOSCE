import { AxiosError } from "axios";
import jwt from "jsonwebtoken";
import request from "supertest";

import { CENARIOS_OSCE } from "@/shared/constants/cenarios-osce";

// Gemini mockada: as rotas nunca chamam a API real nos testes. O mock e tipado como
// `any` só no `post` para poder alternar resolve/reject por teste sem um client axios de verdade.
const postMock = jest.fn();
jest.mock("@/shared/clients/gemini.client", () => ({
  geminiClient: { post: (...args: unknown[]) => postMock(...args) },
}));

// Importa depois do mock, para a rota enxergar o geminiClient mockado.
import { aplicacao } from "@/app";

const CENARIO_ID = CENARIOS_OSCE[0].id;
const token = jwt.sign({ sub: "aluno-1", papel: "aluno", status: "ativo" }, "test-secret");

const respostaGemini = (texto: string) => ({
  data: { candidates: [{ content: { parts: [{ text: texto }] } }] },
});

beforeEach(() => {
  postMock.mockReset();
});

describe("GET /health", () => {
  it("responde 200 com status ok", async () => {
    const resposta = await request(aplicacao).get("/health");

    expect(resposta.status).toBe(200);
    expect(resposta.body.dados.status).toBe("ok");
  });
});

describe("rota desconhecida", () => {
  it("responde 404 padronizado", async () => {
    const resposta = await request(aplicacao).get("/rota-que-nao-existe");

    expect(resposta.status).toBe(404);
    expect(resposta.body.erro.codigo).toBe("NAO_ENCONTRADO");
  });
});

describe("CORS", () => {
  it("rejeita origem nao permitida com 403", async () => {
    const resposta = await request(aplicacao)
      .get("/health")
      .set("Origin", "http://origem-nao-permitida.com");

    expect(resposta.status).toBe(403);
    expect(resposta.body.erro.codigo).toBe("PROIBIDO");
  });
});

describe("autenticacao das rotas OSCE", () => {
  it("responde 401 sem token", async () => {
    const resposta = await request(aplicacao).get("/osce/cenarios");

    expect(resposta.status).toBe(401);
    expect(resposta.body.erro.codigo).toBe("NAO_AUTORIZADO");
  });

  it("responde 401 com token invalido", async () => {
    const resposta = await request(aplicacao)
      .get("/osce/cenarios")
      .set("Authorization", "Bearer token-invalido");

    expect(resposta.status).toBe(401);
    expect(resposta.body.erro.codigo).toBe("NAO_AUTORIZADO");
  });

  it("aceita token valido sem claims opcionais (sub/papel/status ausentes)", async () => {
    const tokenMinimo = jwt.sign({}, "test-secret");
    const resposta = await request(aplicacao)
      .get("/osce/cenarios")
      .set("Authorization", `Bearer ${tokenMinimo}`);

    expect(resposta.status).toBe(200);
  });
});

describe("GET /osce/cenarios", () => {
  it("lista so os campos publicos dos cenarios", async () => {
    const resposta = await request(aplicacao)
      .get("/osce/cenarios")
      .set("Authorization", `Bearer ${token}`);

    expect(resposta.status).toBe(200);
    expect(resposta.body.cenarios).toHaveLength(CENARIOS_OSCE.length);
    expect(resposta.body.cenarios[0]).toEqual({
      id: CENARIOS_OSCE[0].id,
      titulo: CENARIOS_OSCE[0].titulo,
      especialidade: CENARIOS_OSCE[0].especialidade,
      dificuldade: CENARIOS_OSCE[0].dificuldade,
    });
  });
});

describe("POST /osce/:id/mensagem", () => {
  it("responde 404 para cenario inexistente", async () => {
    const resposta = await request(aplicacao)
      .post("/osce/cenario-inexistente/mensagem")
      .set("Authorization", `Bearer ${token}`)
      .send({ mensagem: "Bom dia, como o senhor esta se sentindo?" });

    expect(resposta.status).toBe(404);
    expect(resposta.body.erro.codigo).toBe("NAO_ENCONTRADO");
  });

  it("responde 400 com mensagem vazia", async () => {
    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/mensagem`)
      .set("Authorization", `Bearer ${token}`)
      .send({ mensagem: "" });

    expect(resposta.status).toBe(400);
    expect(resposta.body.erro.codigo).toBe("REQUISICAO_INVALIDA");
  });

  it("devolve a fala do paciente interpretada pela IA", async () => {
    postMock.mockResolvedValueOnce(respostaGemini("Estou com dor no peito ha duas horas."));

    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/mensagem`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        mensagem: "Bom dia, o que o senhor esta sentindo?",
        historico: [{ autor: "paciente", texto: "Estou com dor no peito." }],
      });

    expect(resposta.status).toBe(200);
    expect(resposta.body.resposta).toBe("Estou com dor no peito ha duas horas.");
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("responde 502 quando a IA nao devolve texto", async () => {
    postMock.mockResolvedValueOnce({ data: { candidates: [] } });

    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/mensagem`)
      .set("Authorization", `Bearer ${token}`)
      .send({ mensagem: "Alo?" });

    expect(resposta.status).toBe(502);
    expect(resposta.body.erro.codigo).toBe("ERRO_DOWNSTREAM");
  });

  it("responde 504 quando a chamada a Gemini expira", async () => {
    postMock.mockRejectedValueOnce(new AxiosError("timeout", "ECONNABORTED"));

    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/mensagem`)
      .set("Authorization", `Bearer ${token}`)
      .send({ mensagem: "Alo?" });

    expect(resposta.status).toBe(504);
    expect(resposta.body.erro.codigo).toBe("TIMEOUT_DOWNSTREAM");
  });

  it("responde 502 para falha Axios que nao e timeout", async () => {
    postMock.mockRejectedValueOnce(new AxiosError("falha de rede", "ECONNRESET"));

    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/mensagem`)
      .set("Authorization", `Bearer ${token}`)
      .send({ mensagem: "Alo?" });

    expect(resposta.status).toBe(502);
    expect(resposta.body.erro.codigo).toBe("ERRO_DOWNSTREAM");
  });

  it("responde 500 generico para erro inesperado", async () => {
    postMock.mockRejectedValueOnce(new Error("falha inesperada"));

    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/mensagem`)
      .set("Authorization", `Bearer ${token}`)
      .send({ mensagem: "Alo?" });

    expect(resposta.status).toBe(500);
    expect(resposta.body.erro.codigo).toBe("ERRO_INTERNO");
  });
});

describe("POST /osce/:id/finalizar", () => {
  it("responde 400 sem historico", async () => {
    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/finalizar`)
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(resposta.status).toBe(400);
    expect(resposta.body.erro.codigo).toBe("REQUISICAO_INVALIDA");
  });

  it("responde 502 quando a IA devolve JSON invalido", async () => {
    postMock.mockResolvedValueOnce(respostaGemini("isto nao e json"));

    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/finalizar`)
      .set("Authorization", `Bearer ${token}`)
      .send({ historico: [{ autor: "aluno", texto: "Onde dói?" }] });

    expect(resposta.status).toBe(502);
    expect(resposta.body.erro.codigo).toBe("ERRO_DOWNSTREAM");
  });

  it("pontua a rubrica a partir do julgamento da IA", async () => {
    const cenario = CENARIOS_OSCE[0];
    const julgamentoIa = {
      itens: cenario.rubrica.map((item) => ({
        id: item.id,
        nivel: "competente",
        justificativa: "Evidenciado na transcricao.",
      })),
      notaGlobal: "4",
      justificativaNotaGlobal: "Conduziu com seguranca.",
      comentarioFinal: "Muito bem, faltou explorar diferenciais.",
    };
    postMock.mockResolvedValueOnce(respostaGemini(JSON.stringify(julgamentoIa)));

    const resposta = await request(aplicacao)
      .post(`/osce/${cenario.id}/finalizar`)
      .set("Authorization", `Bearer ${token}`)
      .send({ historico: [{ autor: "aluno", texto: "Onde dói e como é a dor?" }] });

    expect(resposta.status).toBe(200);
    expect(resposta.body.avaliacao.cenarioId).toBe(cenario.id);
    expect(resposta.body.avaliacao.percentual).toBe(100);
    expect(resposta.body.avaliacao.aprovado).toBe(true);
    expect(resposta.body.avaliacao.comentarioFinal).toBe(julgamentoIa.comentarioFinal);
  });
});
