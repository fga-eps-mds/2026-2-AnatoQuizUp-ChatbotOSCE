// Conversa com o paciente simulado (US25). A IA continua interpretando o paciente,
// mas so com o que o PACIENTE sabe (perfil, queixa e historia). Exame fisico e
// resultados de exames ficam fora do prompt: quando o aluno pede um exame, a IA so
// IDENTIFICA o pedido e o resultado e copiado do cadastro do caso, em codigo. Assim o
// paciente nao tem como inventar, adiantar ou "traduzir" um resultado.
import { z } from "zod";

import type { CenarioOsce, ExameComplementarOsce } from "@/shared/constants/cenarios-osce";

// Quem produziu cada turno do historico. "exame" e "indisponivel" nao sao falas: sao
// cards montados pelo servico a partir do cadastro do caso.
export const AUTORES_TURNO = ["aluno", "paciente", "exame", "indisponivel"] as const;

export type AutorTurno = (typeof AUTORES_TURNO)[number];

export type TurnoSimulacao = {
  autor: AutorTurno;
  texto: string;
  // Nome do exame, so nos turnos "exame" e "indisponivel".
  exame?: string;
};

export const NOME_EXAME_FISICO = "Exame físico";
export const TEXTO_EXAME_INDISPONIVEL = "Não disponível neste caso.";

// Turno do historico recebido do front. O texto de um exame pode ser longo (o exame
// fisico do cadastro aceita ate 5000 caracteres no Quiz-Service), por isso o limite
// maior que o de uma fala.
export const schemaTurno = z
  .object({
    autor: z.enum(AUTORES_TURNO),
    texto: z.string().trim().min(1).max(5000),
    exame: z.string().trim().min(1).max(200).optional(),
  })
  .refine((turno) => turno.autor === "aluno" || turno.autor === "paciente" || !!turno.exame, {
    message: "Turno de exame precisa do nome do exame.",
  });

// Resposta estruturada que a Gemini devolve a cada fala do aluno.
export const schemaRespostaPaciente = z.object({
  fala: z.string().trim().default(""),
  pediuExameFisico: z.boolean().default(false),
  examesSolicitados: z.array(z.string().trim().min(1)).default([]),
  examesNaoCadastrados: z.array(z.string().trim().min(1)).default([]),
});

export type RespostaPaciente = z.infer<typeof schemaRespostaPaciente>;

// Compara nomes de exame sem diferenciar acento, caixa e espacos.
export function normalizarNome(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function buscarExame(cenario: CenarioOsce, nome: string): ExameComplementarOsce | undefined {
  const alvo = normalizarNome(nome);
  return cenario.exames.find((exame) => normalizarNome(exame.nome) === alvo);
}

// Instrucao de sistema do "modo paciente". Leva so perfil, queixa e historia: o exame
// fisico e os resultados de exames NUNCA entram aqui. Dos exames, a IA recebe apenas os
// nomes, para conseguir reconhecer o pedido do aluno (inclusive por sigla).
export function montarInstrucaoPaciente(cenario: CenarioOsce): string {
  const nomesExames = cenario.exames.length
    ? cenario.exames.map((exame) => `- ${exame.nome}`).join("\n")
    : "- (nenhum exame complementar cadastrado neste caso)";

  return (
    `Voce esta interpretando um paciente em uma simulacao OSCE (exame clinico estruturado) ` +
    `para treinar estudantes de medicina. Responda sempre em portugues do Brasil, em primeira ` +
    `pessoa, como o paciente descrito abaixo.\n\n` +
    `Perfil do paciente: ${cenario.perfilPaciente}\n` +
    `Queixa principal: ${cenario.queixaPrincipal}\n` +
    `Historia e sintomas (revele apenas o que for perguntado, nunca tudo de uma vez): ` +
    `${cenario.historiaSintomas}\n\n` +
    `O que o paciente sabe: somente o perfil, a queixa e a historia acima. Regras:\n` +
    `- Se o medico perguntar algo que nao esta no perfil, na queixa ou na historia, diga com ` +
    `naturalidade que nao sabe ou nao se lembra. Nunca invente sintomas, doencas, remedios, ` +
    `datas, numeros ou antecedentes.\n` +
    `- O paciente nao sabe resultados de exames nem os proprios sinais vitais (pressao, ` +
    `frequencia, temperatura medida). Nunca diga valores que nao estejam na historia.\n` +
    `- Nunca saia do personagem; nunca diga o nome de um diagnostico medico ` +
    `(ex.: nao diga "${cenario.diagnosticoEsperado}"); nunca mencione que isto e uma simulacao.\n` +
    `- Se o medico usar um termo tecnico que o paciente nao entenderia, responda como uma ` +
    `pessoa leiga responderia.\n\n` +
    `Pedidos de exame: voce NAO responde resultados. Apenas identifique o pedido nos campos ` +
    `do JSON; o resultado e entregue ao medico pelo sistema.\n` +
    `- "pediuExameFisico": true quando o medico examina ou pede para examinar o paciente ` +
    `(examinar, auscultar, palpar, medir pressao, temperatura, sinais vitais). Uma pergunta ` +
    `sobre sintoma ("teve febre?") NAO e exame fisico: responda na "fala".\n` +
    `- "examesSolicitados": exames complementares pedidos pelo medico que estao nesta lista ` +
    `(use o nome exatamente como aparece; aceite siglas e sinonimos, ex.: ECG = ` +
    `Eletrocardiograma):\n${nomesExames}\n` +
    `- "examesNaoCadastrados": exames complementares pedidos pelo nome que NAO estao na lista. ` +
    `Escreva o nome como o medico disse. So associe a um exame da lista se for o mesmo exame.\n` +
    `- Pedido generico, sem nome de exame ("vou pedir uns exames"), nao entra em nenhuma lista.\n` +
    `- "fala": o que o paciente diz em resposta. Se a mensagem for so um pedido de exame, ` +
    `responda algo curto e natural (ex.: "Tudo bem, doutor.") sem comentar o exame.\n\n` +
    `Encerramento: quando o medico se despedir ou disser que vai encerrar a consulta, ` +
    `responda com UMA unica despedida curta (uma frase). Se depois disso o medico ` +
    `continuar se despedindo, nao repita a despedida nem puxe assunto novo: responda ` +
    `de forma minima (por exemplo, apenas "Ok."), sem outra despedida.`
  );
}

// responseSchema da Gemini. O enum de examesSolicitados obriga a IA a escolher entre os
// nomes cadastrados; sem exames cadastrados o campo sai do schema (enum vazio e invalido).
export function montarSchemaRespostaPaciente(cenario: CenarioOsce) {
  const properties: Record<string, unknown> = {
    fala: { type: "STRING" },
    pediuExameFisico: { type: "BOOLEAN" },
    examesNaoCadastrados: { type: "ARRAY", items: { type: "STRING" } },
  };
  const required = ["fala", "pediuExameFisico", "examesNaoCadastrados"];

  if (cenario.exames.length) {
    properties.examesSolicitados = {
      type: "ARRAY",
      items: { type: "STRING", enum: cenario.exames.map((exame) => exame.nome) },
    };
    required.push("examesSolicitados");
  }

  return { type: "OBJECT", properties, required };
}

// Transforma a interpretacao da IA nos turnos que o aluno ve: a fala do paciente e,
// depois dela, um card por exame. Todo texto de exame vem do cadastro do caso.
export function montarTurnosResposta(
  cenario: CenarioOsce,
  resposta: RespostaPaciente,
): TurnoSimulacao[] {
  const turnos: TurnoSimulacao[] = [];
  const jaIncluidos = new Set<string>();

  const adicionar = (turno: TurnoSimulacao & { exame: string }) => {
    const chave = normalizarNome(turno.exame);
    if (jaIncluidos.has(chave)) return;
    jaIncluidos.add(chave);
    turnos.push(turno);
  };

  if (resposta.fala) {
    turnos.push({ autor: "paciente", texto: resposta.fala });
  }

  if (resposta.pediuExameFisico) {
    adicionar(
      cenario.exameFisico.trim()
        ? { autor: "exame", exame: NOME_EXAME_FISICO, texto: cenario.exameFisico }
        : { autor: "indisponivel", exame: NOME_EXAME_FISICO, texto: TEXTO_EXAME_INDISPONIVEL },
    );
  }

  // Um nome fora do cadastro (que o enum deveria impedir) cai como indisponivel: a
  // resposta nunca traz um resultado que nao esteja escrito no caso.
  for (const nome of resposta.examesSolicitados) {
    const exame = buscarExame(cenario, nome);
    adicionar(
      exame
        ? { autor: "exame", exame: exame.nome, texto: exame.resultado }
        : { autor: "indisponivel", exame: nome, texto: TEXTO_EXAME_INDISPONIVEL },
    );
  }

  // Se a IA puser um exame cadastrado na lista errada, o aluno recebe o resultado.
  for (const nome of resposta.examesNaoCadastrados) {
    const exame = buscarExame(cenario, nome);
    adicionar(
      exame
        ? { autor: "exame", exame: exame.nome, texto: exame.resultado }
        : { autor: "indisponivel", exame: nome, texto: TEXTO_EXAME_INDISPONIVEL },
    );
  }

  return turnos;
}

type ConteudoGemini = { role: "user" | "model"; parts: { text: string }[] };

// Historico -> "contents" da Gemini, do ponto de vista do PACIENTE: aluno = user,
// paciente = model. Os cards de exame entram so como nota de que o medico recebeu o
// resultado, SEM o resultado, para o paciente continuar sem conhecer os achados.
// Turnos seguidos do mesmo papel sao agrupados num unico conteudo.
export function historicoParaContents(historico: TurnoSimulacao[]): ConteudoGemini[] {
  const contents: ConteudoGemini[] = [];

  for (const turno of historico) {
    const role = turno.autor === "paciente" ? "model" : "user";
    let texto = turno.texto;
    if (turno.autor === "exame") {
      texto = `[Nota da simulacao: o medico recebeu o resultado de "${turno.exame}". O paciente nao conhece o resultado.]`;
    } else if (turno.autor === "indisponivel") {
      texto = `[Nota da simulacao: o exame "${turno.exame}" nao esta disponivel neste caso.]`;
    }

    const anterior = contents.at(-1);
    if (anterior?.role === role) {
      anterior.parts.push({ text: texto });
    } else {
      contents.push({ role, parts: [{ text: texto }] });
    }
  }

  return contents;
}

// Transcricao usada na avaliacao final: aqui o examinador PRECISA ver os exames pedidos
// e os resultados entregues, porque varios itens do checklist dependem disso.
export function montarTranscricao(historico: TurnoSimulacao[]): string {
  return historico
    .map((turno) => {
      switch (turno.autor) {
        case "aluno":
          return `Aluno: ${turno.texto}`;
        case "paciente":
          return `Paciente: ${turno.texto}`;
        case "exame":
          return `[Resultado entregue ao aluno — ${turno.exame}]: ${turno.texto}`;
        default:
          return `[Exame pedido pelo aluno e indisponivel no caso — ${turno.exame}]`;
      }
    })
    .join("\n");
}
