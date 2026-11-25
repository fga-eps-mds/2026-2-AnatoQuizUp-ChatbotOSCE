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
const tokenProfessor = jwt.sign(
  { sub: "professor-1", papel: "PROFESSOR", status: "ATIVO" },
  "test-secret",
);
// Mesmo default de teste de INTERNAL_TOKEN (ver obrigatoriaComDefaultDeTeste em config/env.ts).
const TOKEN_INTERNO = "test-internal-token";

const respostaGemini = (texto: string) => ({
  data: { candidates: [{ content: { parts: [{ text: texto }] } }] },
});

// Resposta estruturada do "modo paciente" (US25): fala + exames identificados.
const respostaPaciente = (campos: {
  fala: string;
  pediuExameFisico?: boolean;
  examesSolicitados?: string[];
  examesNaoCadastrados?: string[];
}) =>
  respostaGemini(
    JSON.stringify({
      pediuExameFisico: false,
      examesSolicitados: [],
      examesNaoCadastrados: [],
      ...campos,
    }),
  );

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

describe("token interno das rotas OSCE", () => {
  it("responde 403 sem x-internal-token", async () => {
    const resposta = await request(aplicacao)
      .get("/osce/cenarios")
      .set("Authorization", `Bearer ${token}`);

    expect(resposta.status).toBe(403);
    expect(resposta.body.erro.codigo).toBe("PROIBIDO");
  });

  it("responde 403 com x-internal-token errado", async () => {
    const resposta = await request(aplicacao)
      .get("/osce/cenarios")
      .set("x-internal-token", "token-errado")
      .set("Authorization", `Bearer ${token}`);

    expect(resposta.status).toBe(403);
    expect(resposta.body.erro.codigo).toBe("PROIBIDO");
  });
});

describe("autenticacao das rotas OSCE", () => {
  it("responde 401 sem token", async () => {
    const resposta = await request(aplicacao)
      .get("/osce/cenarios")
      .set("x-internal-token", TOKEN_INTERNO);

    expect(resposta.status).toBe(401);
    expect(resposta.body.erro.codigo).toBe("NAO_AUTORIZADO");
  });

  it("responde 401 com token invalido", async () => {
    const resposta = await request(aplicacao)
      .get("/osce/cenarios")
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", "Bearer token-invalido");

    expect(resposta.status).toBe(401);
    expect(resposta.body.erro.codigo).toBe("NAO_AUTORIZADO");
  });

  it("aceita token valido sem claims opcionais (sub/papel/status ausentes)", async () => {
    const tokenMinimo = jwt.sign({}, "test-secret");
    const resposta = await request(aplicacao)
      .get("/osce/cenarios")
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${tokenMinimo}`);

    expect(resposta.status).toBe(200);
  });
});

describe("GET /osce/cenarios", () => {
  it("lista so os campos publicos dos cenarios", async () => {
    const resposta = await request(aplicacao)
      .get("/osce/cenarios")
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`);

    expect(resposta.status).toBe(200);
    expect(resposta.body.cenarios).toHaveLength(CENARIOS_OSCE.length);
    expect(resposta.body.cenarios[0]).toEqual({
      id: CENARIOS_OSCE[0].id,
      titulo: CENARIOS_OSCE[0].titulo,
      especialidade: CENARIOS_OSCE[0].especialidade,
      dificuldade: CENARIOS_OSCE[0].dificuldade,
      contextoInicial: CENARIOS_OSCE[0].contextoInicial,
    });
  });

  it("traz o contexto inicial de todos os casos e nenhum campo oculto", async () => {
    const resposta = await request(aplicacao)
      .get("/osce/cenarios")
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`);

    expect(resposta.status).toBe(200);
    for (const cenario of resposta.body.cenarios) {
      expect(Object.keys(cenario.contextoInicial).sort()).toEqual(
        ["idade", "local", "papelEstudante", "queixa", "sexo"],
      );
      expect(cenario).not.toHaveProperty("diagnosticoEsperado");
      expect(cenario).not.toHaveProperty("historiaSintomas");
      expect(cenario).not.toHaveProperty("exameFisico");
      expect(cenario).not.toHaveProperty("exames");
      expect(cenario).not.toHaveProperty("perfilPaciente");
      expect(cenario).not.toHaveProperty("queixaPrincipal");
      expect(cenario).not.toHaveProperty("rubrica");
    }
  });
});

const normalizar = (texto: string) =>
  texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// Palavras significativas do diagnostico (ex.: "apendicite", "coronariana").
const palavrasDoDiagnostico = (diagnostico: string) =>
  normalizar(diagnostico)
    .split(/[^a-z]+/)
    .filter((palavra) => palavra.length > 5);

describe("contextoInicial dos cenarios", () => {
  it.each(CENARIOS_OSCE.map((cenario) => [cenario.id, cenario] as const))(
    "%s nao revela o diagnostico esperado",
    (_id, cenario) => {
      const contexto = normalizar(JSON.stringify(cenario.contextoInicial));
      expect(contexto).not.toContain(normalizar(cenario.diagnosticoEsperado));
      // Cada palavra significativa do diagnostico tambem nao pode aparecer isolada.
      for (const palavra of palavrasDoDiagnostico(cenario.diagnosticoEsperado)) {
        expect(contexto).not.toContain(palavra);
      }
    },
  );

  it.each(CENARIOS_OSCE.map((cenario) => [cenario.id, cenario] as const))(
    "%s nao reaproveita a queixa do roteiro",
    (_id, cenario) => {
      expect(normalizar(cenario.queixaPrincipal)).not.toContain(
        normalizar(cenario.contextoInicial.queixa),
      );
    },
  );

  it.each(CENARIOS_OSCE.map((cenario) => [cenario.id, cenario] as const))(
    "%s tem idade e sexo coerentes com o perfil do paciente",
    (_id, cenario) => {
      const { idade, sexo } = cenario.contextoInicial;
      expect(cenario.perfilPaciente).toContain(`${idade} anos`);
      if (sexo === "Feminino") {
        expect(cenario.perfilPaciente).toMatch(/^Mulher/);
      } else {
        expect(cenario.perfilPaciente).not.toMatch(/^Mulher/);
      }
    },
  );
});

describe("titulo dos cenarios", () => {
  // O titulo aparece no card antes do atendimento: nao pode entregar o
  // diagnostico nem itens criticos da rubrica (inicio subito, localizacao).
  const termosProibidos = ["subit", "fossa iliaca"];

  it.each(CENARIOS_OSCE.map((cenario) => [cenario.id, cenario] as const))(
    "%s nao sugere o diagnostico no titulo",
    (_id, cenario) => {
      const titulo = normalizar(cenario.titulo);
      for (const palavra of palavrasDoDiagnostico(cenario.diagnosticoEsperado)) {
        expect(titulo).not.toContain(palavra);
      }
      for (const termo of termosProibidos) {
        expect(titulo).not.toContain(termo);
      }
    },
  );
});

describe("POST /osce/:id/mensagem", () => {
  it("responde 404 para cenario inexistente", async () => {
    const resposta = await request(aplicacao)
      .post("/osce/cenario-inexistente/mensagem")
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`)
      .send({ mensagem: "Bom dia, como o senhor esta se sentindo?" });

    expect(resposta.status).toBe(404);
    expect(resposta.body.erro.codigo).toBe("NAO_ENCONTRADO");
  });

  it("responde 400 com mensagem vazia", async () => {
    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/mensagem`)
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`)
      .send({ mensagem: "" });

    expect(resposta.status).toBe(400);
    expect(resposta.body.erro.codigo).toBe("REQUISICAO_INVALIDA");
  });

  it("devolve a fala do paciente interpretada pela IA", async () => {
    postMock.mockResolvedValueOnce(
      respostaPaciente({ fala: "Estou com dor no peito ha duas horas." }),
    );

    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/mensagem`)
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`)
      .send({
        mensagem: "Bom dia, o que o senhor esta sentindo?",
        historico: [{ autor: "paciente", texto: "Estou com dor no peito." }],
      });

    expect(resposta.status).toBe(200);
    expect(resposta.body.resposta).toBe("Estou com dor no peito ha duas horas.");
    expect(resposta.body.turnos).toEqual([
      { autor: "paciente", texto: "Estou com dor no peito ha duas horas." },
    ]);
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("pede JSON estruturado com os nomes dos exames do caso como enum", async () => {
    postMock.mockResolvedValueOnce(respostaPaciente({ fala: "Tudo bem." }));

    await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/mensagem`)
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`)
      .send({ mensagem: "Vou pedir um ECG." });

    const payload = postMock.mock.calls[0][1] as {
      generationConfig: {
        responseMimeType: string;
        responseSchema: {
          properties: { examesSolicitados: { items: { enum: string[] } } };
        };
      };
    };
    expect(payload.generationConfig.responseMimeType).toBe("application/json");
    expect(payload.generationConfig.responseSchema.properties.examesSolicitados.items.enum).toEqual(
      CENARIOS_OSCE[0].exames.map((exame) => exame.nome),
    );
  });

  it("nao coloca exame fisico nem resultados de exames na instrucao do paciente", async () => {
    postMock.mockResolvedValueOnce(respostaPaciente({ fala: "Oi, doutor." }));
    const cenario = CENARIOS_OSCE[0];

    await request(aplicacao)
      .post(`/osce/${cenario.id}/mensagem`)
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`)
      .send({ mensagem: "Bom dia." });

    const payload = postMock.mock.calls[0][1] as {
      system_instruction: { parts: { text: string }[] };
    };
    const instrucao = payload.system_instruction.parts[0].text;
    expect(instrucao).toContain(cenario.historiaSintomas);
    expect(instrucao).not.toContain(cenario.exameFisico);
    for (const exame of cenario.exames) {
      expect(instrucao).toContain(exame.nome);
      expect(instrucao).not.toContain(exame.resultado);
    }
    expect(instrucao).toContain("diga com naturalidade que nao sabe");
  });

  it("devolve o resultado cadastrado do exame pedido, sem passar pela fala do paciente", async () => {
    const cenario = CENARIOS_OSCE[0];
    const ecg = cenario.exames[0];
    postMock.mockResolvedValueOnce(
      respostaPaciente({
        fala: "Tudo bem, doutor.",
        pediuExameFisico: true,
        examesSolicitados: [ecg.nome],
        examesNaoCadastrados: ["Tomografia de tórax"],
      }),
    );

    const resposta = await request(aplicacao)
      .post(`/osce/${cenario.id}/mensagem`)
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`)
      .send({ mensagem: "Vou examinar o senhor e pedir um ECG e uma tomografia de tórax." });

    expect(resposta.status).toBe(200);
    expect(resposta.body.resposta).toBe("Tudo bem, doutor.");
    expect(resposta.body.turnos).toEqual([
      { autor: "paciente", texto: "Tudo bem, doutor." },
      { autor: "exame", exame: "Exame físico", texto: cenario.exameFisico },
      { autor: "exame", exame: ecg.nome, texto: ecg.resultado },
      {
        autor: "indisponivel",
        exame: "Tomografia de tórax",
        texto: "Não disponível neste caso.",
      },
    ]);
  });

  it("aceita cards de exame no historico sem repassar o resultado ao paciente", async () => {
    const cenario = CENARIOS_OSCE[0];
    const ecg = cenario.exames[0];
    postMock.mockResolvedValueOnce(respostaPaciente({ fala: "Nao sei dizer, doutor." }));

    const resposta = await request(aplicacao)
      .post(`/osce/${cenario.id}/mensagem`)
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`)
      .send({
        mensagem: "O senhor sabe o que deu no exame?",
        historico: [
          { autor: "aluno", texto: "Solicito um ECG." },
          { autor: "paciente", texto: "Tudo bem." },
          { autor: "exame", exame: ecg.nome, texto: ecg.resultado },
        ],
      });

    expect(resposta.status).toBe(200);
    const payload = postMock.mock.calls[0][1] as {
      contents: { role: string; parts: { text: string }[] }[];
    };
    expect(JSON.stringify(payload.contents)).not.toContain(ecg.resultado);
  });

  it("responde 400 para card de exame sem o nome do exame", async () => {
    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/mensagem`)
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`)
      .send({
        mensagem: "E agora?",
        historico: [{ autor: "exame", texto: "Resultado qualquer" }],
      });

    expect(resposta.status).toBe(400);
    expect(postMock).not.toHaveBeenCalled();
  });

  it("responde 502 quando a IA devolve JSON fora do formato", async () => {
    postMock.mockResolvedValueOnce(respostaGemini("Sou o paciente e respondi em texto livre."));

    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/mensagem`)
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`)
      .send({ mensagem: "Bom dia." });

    expect(resposta.status).toBe(502);
    expect(resposta.body.erro.codigo).toBe("ERRO_DOWNSTREAM");
  });

  it("responde 502 quando a IA nao devolve fala nem exame", async () => {
    postMock.mockResolvedValueOnce(respostaPaciente({ fala: "" }));

    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/mensagem`)
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`)
      .send({ mensagem: "Bom dia." });

    expect(resposta.status).toBe(502);
  });

  it("envia a regra de encerramento na instrucao do paciente", async () => {
    postMock.mockResolvedValueOnce(respostaPaciente({ fala: "Obrigado, doutor. Tchau." }));

    await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/mensagem`)
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`)
      .send({ mensagem: "Obrigado, era isso. Tchau!" });

    const payload = postMock.mock.calls[0][1] as {
      system_instruction: { parts: { text: string }[] };
    };
    const instrucao = payload.system_instruction.parts[0].text;
    expect(instrucao).toContain("UMA unica despedida curta");
    expect(instrucao).toContain("nao repita a despedida");
  });

  it("responde 502 quando a IA nao devolve texto", async () => {
    postMock.mockResolvedValueOnce({ data: { candidates: [] } });

    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/mensagem`)
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`)
      .send({ mensagem: "Alo?" });

    expect(resposta.status).toBe(502);
    expect(resposta.body.erro.codigo).toBe("ERRO_DOWNSTREAM");
  });

  it("responde 504 quando a chamada a Gemini expira", async () => {
    postMock.mockRejectedValueOnce(new AxiosError("timeout", "ECONNABORTED"));

    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/mensagem`)
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`)
      .send({ mensagem: "Alo?" });

    expect(resposta.status).toBe(504);
    expect(resposta.body.erro.codigo).toBe("TIMEOUT_DOWNSTREAM");
  });

  it("responde 502 para falha Axios que nao e timeout", async () => {
    postMock.mockRejectedValueOnce(new AxiosError("falha de rede", "ECONNRESET"));

    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/mensagem`)
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`)
      .send({ mensagem: "Alo?" });

    expect(resposta.status).toBe(502);
    expect(resposta.body.erro.codigo).toBe("ERRO_DOWNSTREAM");
  });

  it("responde 500 generico para erro inesperado", async () => {
    postMock.mockRejectedValueOnce(new Error("falha inesperada"));

    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/mensagem`)
      .set("x-internal-token", TOKEN_INTERNO)
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
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(resposta.status).toBe(400);
    expect(resposta.body.erro.codigo).toBe("REQUISICAO_INVALIDA");
  });

  it("responde 502 quando a IA nao devolve texto", async () => {
    postMock.mockResolvedValueOnce({ data: { candidates: [] } });

    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/finalizar`)
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`)
      .send({
        historico: [
          { autor: "aluno", texto: "Onde dói?" },
          { autor: "paciente", texto: "No peito." },
        ],
      });

    expect(resposta.status).toBe(502);
    expect(resposta.body.erro.codigo).toBe("ERRO_DOWNSTREAM");
  });

  it("responde 502 quando a IA devolve JSON invalido", async () => {
    postMock.mockResolvedValueOnce(respostaGemini("isto nao e json"));

    const resposta = await request(aplicacao)
      .post(`/osce/${CENARIO_ID}/finalizar`)
      .set("x-internal-token", TOKEN_INTERNO)
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
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`)
      .send({ historico: [{ autor: "aluno", texto: "Onde dói e como é a dor?" }] });

    expect(resposta.status).toBe(200);
    expect(resposta.body.avaliacao.cenarioId).toBe(cenario.id);
    expect(resposta.body.avaliacao.percentual).toBe(100);
    expect(resposta.body.avaliacao.aprovado).toBe(true);
    expect(resposta.body.avaliacao.comentarioFinal).toBe(julgamentoIa.comentarioFinal);
  });

  it("inclui os exames pedidos e entregues na transcricao avaliada", async () => {
    const cenario = CENARIOS_OSCE[0];
    const ecg = cenario.exames[0];
    postMock.mockResolvedValueOnce(respostaGemini("{}"));

    await request(aplicacao)
      .post(`/osce/${cenario.id}/finalizar`)
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`)
      .send({
        historico: [
          { autor: "aluno", texto: "Solicito um ECG e uma cintilografia." },
          { autor: "exame", exame: ecg.nome, texto: ecg.resultado },
          { autor: "indisponivel", exame: "Cintilografia", texto: "Não disponível neste caso." },
        ],
      });

    const payload = postMock.mock.calls[0][1] as {
      contents: { parts: { text: string }[] }[];
    };
    const transcricao = payload.contents[0].parts[0].text;
    expect(transcricao).toContain(`[Resultado entregue ao aluno — ${ecg.nome}]: ${ecg.resultado}`);
    expect(transcricao).toContain(
      "[Exame pedido pelo aluno e indisponivel no caso — Cintilografia]",
    );
  });
});

describe("POST /osce/melhorar-texto", () => {
  it("responde 401 sem token de acesso", async () => {
    const resposta = await request(aplicacao)
      .post("/osce/melhorar-texto")
      .set("x-internal-token", TOKEN_INTERNO)
      .send({ campo: "titulo", texto: "Paciente com dor no peito ha 2 dias" });

    expect(resposta.status).toBe(401);
    expect(postMock).not.toHaveBeenCalled();
  });

  it("responde 403 quando o usuario nao e professor", async () => {
    const resposta = await request(aplicacao)
      .post("/osce/melhorar-texto")
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${token}`)
      .send({ campo: "titulo", texto: "Paciente com dor no peito ha 2 dias" });

    expect(resposta.status).toBe(403);
    expect(resposta.body.erro.codigo).toBe("PROIBIDO");
    expect(postMock).not.toHaveBeenCalled();
  });

  it("responde 400 quando o texto esta vazio", async () => {
    const resposta = await request(aplicacao)
      .post("/osce/melhorar-texto")
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${tokenProfessor}`)
      .send({ campo: "titulo", texto: "" });

    expect(resposta.status).toBe(400);
    expect(resposta.body.erro.codigo).toBe("REQUISICAO_INVALIDA");
    expect(postMock).not.toHaveBeenCalled();
  });

  it("responde 400 quando o texto excede 4000 caracteres", async () => {
    const resposta = await request(aplicacao)
      .post("/osce/melhorar-texto")
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${tokenProfessor}`)
      .send({ campo: "roteiroOculto", texto: "a".repeat(4001) });

    expect(resposta.status).toBe(400);
    expect(resposta.body.erro.codigo).toBe("REQUISICAO_INVALIDA");
  });

  it("devolve o texto melhorado e nao revela o diagnostico em campos visiveis ao aluno", async () => {
    postMock.mockResolvedValueOnce(respostaGemini("Paciente relata dor toracica ha dois dias."));

    const resposta = await request(aplicacao)
      .post("/osce/melhorar-texto")
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${tokenProfessor}`)
      .send({
        campo: "queixaPaciente",
        texto: "paciente c/ dor no peito ha 2 dias",
        contexto: {
          titulo: "Dor toracica",
          especialidade: "Cardiologia",
          diagnosticoEsperado: "Infarto agudo do miocardio",
        },
      });

    expect(resposta.status).toBe(200);
    expect(resposta.body.textoMelhorado).toBe("Paciente relata dor toracica ha dois dias.");

    const instrucao = postMock.mock.calls[0][1].system_instruction.parts[0].text as string;
    expect(instrucao).toContain('campo "queixaPaciente"');
    expect(instrucao).toContain("nao mencione nem");
    expect(instrucao).toContain("Infarto agudo do miocardio");
  });

  it("nao restringe o diagnostico em campos internos do examinador (ex.: roteiroOculto)", async () => {
    postMock.mockResolvedValueOnce(respostaGemini("Historia clinica revisada."));

    await request(aplicacao)
      .post("/osce/melhorar-texto")
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${tokenProfessor}`)
      .send({
        campo: "roteiroOculto",
        texto: "historia clinica",
        contexto: { diagnosticoEsperado: "Infarto agudo do miocardio" },
      });

    const instrucao = postMock.mock.calls[0][1].system_instruction.parts[0].text as string;
    expect(instrucao).not.toContain("nao mencione nem");
  });

  it("responde 502 quando a IA nao devolve texto", async () => {
    postMock.mockResolvedValueOnce({ data: { candidates: [] } });

    const resposta = await request(aplicacao)
      .post("/osce/melhorar-texto")
      .set("x-internal-token", TOKEN_INTERNO)
      .set("Authorization", `Bearer ${tokenProfessor}`)
      .send({ campo: "titulo", texto: "Paciente com dor no peito" });

    expect(resposta.status).toBe(502);
    expect(resposta.body.erro.codigo).toBe("ERRO_DOWNSTREAM");
  });
});
