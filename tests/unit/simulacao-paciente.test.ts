import { CENARIOS_OSCE, type CenarioOsce } from "@/shared/constants/cenarios-osce";
import {
  historicoParaContents,
  montarInstrucaoPaciente,
  montarSchemaRespostaPaciente,
  montarTranscricao,
  montarTurnosResposta,
  normalizarNome,
  schemaRespostaPaciente,
} from "@/shared/utils/simulacao-paciente";

const cenario = CENARIOS_OSCE[0];

const resposta = (campos: Partial<ReturnType<typeof schemaRespostaPaciente.parse>>) =>
  schemaRespostaPaciente.parse(campos);

const cenarioSemExames: CenarioOsce = { ...cenario, exameFisico: "  ", exames: [] };

describe("normalizarNome", () => {
  it("ignora acento, caixa e espacos repetidos", () => {
    expect(normalizarNome("  Exame   de URINA (EAS) ")).toBe("exame de urina (eas)");
    expect(normalizarNome("Punção lombar")).toBe(normalizarNome("puncao LOMBAR"));
  });
});

describe("montarTurnosResposta", () => {
  it("copia o resultado do cadastro, mesmo com o nome escrito de outro jeito", () => {
    const ecg = cenario.exames[0];

    const turnos = montarTurnosResposta(
      cenario,
      resposta({ examesSolicitados: [ecg.nome.toUpperCase()] }),
    );

    expect(turnos).toEqual([{ autor: "exame", exame: ecg.nome, texto: ecg.resultado }]);
  });

  it("trata nome fora do cadastro como indisponivel, nunca como resultado", () => {
    const turnos = montarTurnosResposta(
      cenario,
      resposta({ examesSolicitados: ["Ecocardiograma"], examesNaoCadastrados: ["D-dímero"] }),
    );

    expect(turnos).toEqual([
      { autor: "indisponivel", exame: "Ecocardiograma", texto: "Não disponível neste caso." },
      { autor: "indisponivel", exame: "D-dímero", texto: "Não disponível neste caso." },
    ]);
  });

  it("entrega o resultado quando a IA poe um exame cadastrado na lista de nao cadastrados", () => {
    const troponina = cenario.exames[1];

    const turnos = montarTurnosResposta(
      cenario,
      resposta({ examesNaoCadastrados: [troponina.nome] }),
    );

    expect(turnos).toEqual([{ autor: "exame", exame: troponina.nome, texto: troponina.resultado }]);
  });

  it("nao repete o mesmo exame pedido duas vezes na mesma mensagem", () => {
    const ecg = cenario.exames[0];

    const turnos = montarTurnosResposta(
      cenario,
      resposta({ examesSolicitados: [ecg.nome, ecg.nome], examesNaoCadastrados: [ecg.nome] }),
    );

    expect(turnos).toHaveLength(1);
  });

  it("devolve o exame fisico inteiro, literal do cadastro", () => {
    const turnos = montarTurnosResposta(
      cenario,
      resposta({ fala: "Pode sim.", pediuExameFisico: true }),
    );

    expect(turnos).toEqual([
      { autor: "paciente", texto: "Pode sim." },
      { autor: "exame", exame: "Exame físico", texto: cenario.exameFisico },
    ]);
  });

  it("marca o exame fisico como indisponivel quando o caso nao tem exame fisico", () => {
    const turnos = montarTurnosResposta(cenarioSemExames, resposta({ pediuExameFisico: true }));

    expect(turnos).toEqual([
      { autor: "indisponivel", exame: "Exame físico", texto: "Não disponível neste caso." },
    ]);
  });

  it("devolve lista vazia quando nao ha fala nem exame", () => {
    expect(montarTurnosResposta(cenario, resposta({}))).toEqual([]);
  });
});

describe("montarSchemaRespostaPaciente", () => {
  it("restringe os exames solicitados aos nomes cadastrados", () => {
    const schema = montarSchemaRespostaPaciente(cenario) as unknown as {
      properties: { examesSolicitados: { items: { enum: string[] } } };
      required: string[];
    };

    expect(schema.properties.examesSolicitados.items.enum).toEqual(
      cenario.exames.map((exame) => exame.nome),
    );
    expect(schema.required).toContain("examesSolicitados");
  });

  it("omite examesSolicitados quando o caso nao tem exames (enum vazio e invalido)", () => {
    const schema = montarSchemaRespostaPaciente(cenarioSemExames) as unknown as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(schema.properties).not.toHaveProperty("examesSolicitados");
    expect(schema.required).not.toContain("examesSolicitados");
  });
});

describe("montarInstrucaoPaciente", () => {
  it("avisa quando o caso nao tem exames complementares", () => {
    expect(montarInstrucaoPaciente(cenarioSemExames)).toContain(
      "nenhum exame complementar cadastrado",
    );
  });

  it("nunca leva o exame fisico nem os resultados para o prompt do paciente", () => {
    for (const caso of CENARIOS_OSCE) {
      const instrucao = montarInstrucaoPaciente(caso);
      expect(instrucao).not.toContain(caso.exameFisico);
      for (const exame of caso.exames) {
        expect(instrucao).not.toContain(exame.resultado);
      }
    }
  });
});

describe("historicoParaContents", () => {
  it("troca o resultado do exame por uma nota e agrupa turnos seguidos do mesmo papel", () => {
    const ecg = cenario.exames[0];

    const contents = historicoParaContents([
      { autor: "aluno", texto: "Solicito um ECG e uma tomografia." },
      { autor: "exame", exame: ecg.nome, texto: ecg.resultado },
      { autor: "indisponivel", exame: "Tomografia", texto: "Não disponível neste caso." },
      { autor: "paciente", texto: "Tudo bem." },
    ]);

    expect(contents).toHaveLength(2);
    expect(contents[0].role).toBe("user");
    expect(contents[0].parts).toHaveLength(3);
    expect(contents[0].parts[1].text).toContain(ecg.nome);
    expect(contents[0].parts[2].text).toContain("nao esta disponivel");
    expect(JSON.stringify(contents)).not.toContain(ecg.resultado);
    expect(contents[1]).toEqual({ role: "model", parts: [{ text: "Tudo bem." }] });
  });
});

describe("montarTranscricao", () => {
  it("identifica falas, resultados entregues e exames indisponiveis", () => {
    const transcricao = montarTranscricao([
      { autor: "aluno", texto: "Pode pedir um raio-x?" },
      { autor: "paciente", texto: "Pode." },
      { autor: "exame", exame: "Radiografia de tórax", texto: "Sem alterações agudas." },
      { autor: "indisponivel", exame: "Cintilografia", texto: "Não disponível neste caso." },
    ]);

    expect(transcricao.split("\n")).toEqual([
      "Aluno: Pode pedir um raio-x?",
      "Paciente: Pode.",
      "[Resultado entregue ao aluno — Radiografia de tórax]: Sem alterações agudas.",
      "[Exame pedido pelo aluno e indisponivel no caso — Cintilografia]",
    ]);
  });
});

describe("cenarios", () => {
  it("todo caso tem historia, exame fisico e exames com nome e resultado", () => {
    for (const caso of CENARIOS_OSCE) {
      expect(caso.historiaSintomas.trim()).not.toBe("");
      expect(caso.exameFisico.trim()).not.toBe("");
      expect(caso.exames.length).toBeGreaterThan(0);
      const nomes = caso.exames.map((exame) => normalizarNome(exame.nome));
      expect(new Set(nomes).size).toBe(nomes.length);
    }
  });
});
