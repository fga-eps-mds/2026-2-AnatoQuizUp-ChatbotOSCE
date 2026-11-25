import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";

import { env } from "@/config/env";
import { geminiClient } from "@/shared/clients/gemini.client";
import {
  buscarCenarioOsce,
  CENARIOS_OSCE,
  NIVEIS_DESEMPENHO,
  NOTAS_GLOBAIS,
  type CenarioOsce,
} from "@/shared/constants/cenarios-osce";
import { MENSAGENS } from "@/shared/constants/mensagens";
import { CodigoDeErro } from "@/shared/errors/codigos-de-erro";
import { ErroAplicacao } from "@/shared/errors/erro-aplicacao";
import { middlewareAutenticacao } from "@/shared/middlewares/autenticacao.middleware";
import { middlewareTokenInterno } from "@/shared/middlewares/token-interno.middleware";
import { pontuarRubrica } from "@/shared/utils/pontuacao-osce";
import {
  historicoParaContents,
  montarInstrucaoPaciente,
  montarSchemaRespostaPaciente,
  montarTranscricao,
  montarTurnosResposta,
  schemaRespostaPaciente,
  schemaTurno,
} from "@/shared/utils/simulacao-paciente";

// O historico traz falas e cards de exame (US25); 100 turnos cobrem uma estacao longa
// com varios exames pedidos.
const LIMITE_TURNOS_HISTORICO = 100;

const schemaMensagem = z.object({
  mensagem: z.string().trim().min(1).max(500),
  historico: z.array(schemaTurno).max(LIMITE_TURNOS_HISTORICO).default([]),
});

const schemaFinalizar = z.object({
  historico: z.array(schemaTurno).max(LIMITE_TURNOS_HISTORICO),
});

// Contexto opcional do caso, so pra orientar a reescrita (nao e persistido aqui).
const schemaMelhorarTexto = z.object({
  campo: z.string().trim().min(1).max(100),
  texto: z.string().trim().min(1).max(4000),
  contexto: z
    .object({
      titulo: z.string().trim().max(200).optional(),
      especialidade: z.string().trim().max(200).optional(),
      diagnosticoEsperado: z.string().trim().max(200).optional(),
    })
    .optional(),
});

// Campos visiveis ao aluno ANTES do diagnostico: nunca podem revelar o diagnostico
// esperado, mesmo quando o professor o informa no contexto para dar mais nuance ao caso.
const CAMPOS_SEM_DIAGNOSTICO = new Set(["queixaPaciente", "perfilPaciente", "titulo"]);

type RespostaGerarConteudo = {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
};

// Thinking no nivel minimo: no nivel alto a chamada demora mais e pode estourar o
// REQUEST_TIMEOUT_MS. O minimo exposto pelo modelo e `thinkingLevel: "low"`.
const GERACAO_THINKING_MINIMO = { thinkingConfig: { thinkingLevel: "low" } };

// A Gemini responde JSON por responseMimeType, mas um corpo malformado nao pode
// derrubar a rota: devolve null e o safeParse acima transforma em 502.
function parseJsonOuNulo(texto: string): unknown {
  try {
    return JSON.parse(texto);
  } catch {
    return null;
  }
}

// Busca o cenario pelo :id da rota ou lanca 404 — repetido nas rotas abaixo.
function obterCenarioOuFalhar(id: string | string[]): CenarioOsce {
  const cenario = buscarCenarioOsce(String(id));
  if (!cenario) {
    throw new ErroAplicacao({
      codigoStatus: 404,
      codigo: CodigoDeErro.NAO_ENCONTRADO,
      mensagem: MENSAGENS.cenarioOsceNaoEncontrado,
    });
  }
  return cenario;
}

// Instrucao de sistema para a avaliacao final: aqui a IA sai do personagem e vira
// examinador. Ela NAO calcula nota — so (a) classifica cada item do checklist contra
// as ancoras comportamentais do item e (b) atribui uma nota global holistica. Pesos,
// soma, corte e divergencia sao calculados em codigo (pontuarRubrica).
function montarInstrucaoAvaliacao(cenario: CenarioOsce): string {
  const rubrica = cenario.rubrica
    .map((item) => {
      const parcial = item.ancoras.parcial
        ? `\n  PARCIAL (metade do peso): ${item.ancoras.parcial}`
        : `\n  (Este item nao tem credito parcial: e competente ou nao realizado.)`;
      return (
        `- id "${item.id}" [${item.dominio}] ${item.descricao}\n` +
        `  COMPETENTE (peso cheio): ${item.ancoras.competente}${parcial}`
      );
    })
    .join("\n");

  const escalaGlobal = NOTAS_GLOBAIS.map(
    (nota) => `  ${nota.valor} = ${nota.rotulo}: ${nota.ancora}`,
  ).join("\n");

  return (
    `Voce e um examinador de OSCE avaliando a anamnese de um estudante de medicina. ` +
    `Responda em portugues do Brasil. Nao interprete mais o paciente — avalie a conversa.\n` +
    `Diagnostico esperado pelo caso: ${cenario.diagnosticoEsperado}.\n` +
    `Na transcricao, as linhas entre colchetes nao sao falas: registram o resultado de um ` +
    `exame que o aluno pediu e recebeu, ou um exame pedido que nao estava disponivel no ` +
    `caso. Use-as como evidencia de que o aluno solicitou aquele exame.\n\n` +
    `PARTE 1 — checklist. Para CADA item abaixo, escolha o nivel usando as ancoras do ` +
    `proprio item como criterio (nao a sua impressao geral):\n${rubrica}\n\n` +
    `Niveis possiveis: "competente" (a ancora COMPETENTE foi cumprida), "parcial" ` +
    `(a ancora PARCIAL descreve o que aconteceu) e "nao_realizado" (nao ha evidencia ` +
    `do comportamento na conversa).\n\n` +
    `PARTE 2 — nota global. Independentemente da soma do checklist, julgue o desempenho ` +
    `como um todo nesta escala de confianca:\n${escalaGlobal}\n\n` +
    `Regras: julgue apenas pelo que esta escrito na transcricao — nunca presuma o que ` +
    `o aluno "provavelmente" quis dizer; na justificativa de cada item cite um trecho ` +
    `curto da fala do aluno que sustenta o nivel (ou diga que nao houve); devolva um ` +
    `objeto para cada id da rubrica, sem inventar ids novos; nao some pontos nem ` +
    `calcule percentuais — isso nao e seu trabalho. ` +
    `Em "comentarioFinal", escreva 2-3 frases didaticas sobre o que faltou investigar.`
  );
}

type ContextoMelhorarTexto = z.infer<typeof schemaMelhorarTexto>["contexto"];

// Instrucao de sistema para o botao "melhorar com IA" do editor de caso: aqui a IA
// e so revisora de texto, nunca inventa dado clinico nem decide o diagnostico.
function montarInstrucaoMelhorarTexto(campo: string, contexto: ContextoMelhorarTexto): string {
  const partes = [
    `Voce e um assistente de redacao clinica que ajuda professores de medicina a escrever ` +
      `casos de simulacao OSCE (exame clinico estruturado).`,
    `Reescreva o texto do campo "${campo}" em portugues clinico claro e objetivo: corrija ` +
      `gramatica, ortografia e coesao, mas preserve EXATAMENTE todos os fatos, sintomas, ` +
      `valores e dados clinicos informados — nunca invente, remova ou altere informacao.`,
    `Devolva APENAS o texto reescrito, sem comentarios, aspas, titulos ou explicacoes.`,
  ];

  if (contexto?.titulo) partes.push(`Titulo do caso: ${contexto.titulo}.`);
  if (contexto?.especialidade) partes.push(`Especialidade: ${contexto.especialidade}.`);
  if (contexto?.diagnosticoEsperado && CAMPOS_SEM_DIAGNOSTICO.has(campo)) {
    partes.push(
      `Este texto e visivel ao aluno antes de ele chegar ao diagnostico: nao mencione nem ` +
        `sugira o diagnostico ("${contexto.diagnosticoEsperado}") no texto reescrito.`,
    );
  }

  return partes.join(" ");
}

// Schema que a Gemini e obrigada a seguir na resposta (responseSchema nativo da API):
// um nivel + justificativa por item do checklist, a nota global e o comentario final.
function montarSchemaAvaliacao(cenario: CenarioOsce) {
  return {
    type: "OBJECT",
    properties: {
      itens: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING", enum: cenario.rubrica.map((item) => item.id) },
            nivel: { type: "STRING", enum: [...NIVEIS_DESEMPENHO] },
            justificativa: { type: "STRING" },
          },
          required: ["id", "nivel", "justificativa"],
        },
      },
      // STRING + enum: na Gemini o `enum` do responseSchema so vale para STRING.
      // O z.coerce.number() do schema de validacao converte de volta para inteiro.
      notaGlobal: {
        type: "STRING",
        enum: NOTAS_GLOBAIS.map((nota) => String(nota.valor)),
      },
      justificativaNotaGlobal: { type: "STRING" },
      comentarioFinal: { type: "STRING" },
    },
    required: ["itens", "notaGlobal", "justificativaNotaGlobal", "comentarioFinal"],
  };
}

// Valida a resposta da IA antes de pontuar: id, nivel ou nota fora do esperado vira
// 502, nunca uma nota silenciosamente errada.
const schemaAvaliacaoIa = z.object({
  itens: z.array(
    z.object({
      id: z.string().min(1),
      nivel: z.enum(NIVEIS_DESEMPENHO),
      justificativa: z.string().trim().default(""),
    }),
  ),
  notaGlobal: z.coerce.number().int().min(0).max(NOTAS_GLOBAIS.length - 1),
  justificativaNotaGlobal: z.string().trim().default(""),
  comentarioFinal: z.string().trim().default(""),
});

const router = Router();

// Primeiro confirma que a chamada veio do BFF, depois valida o JWT do usuario final.
router.use(middlewareTokenInterno);
router.use(middlewareAutenticacao);

// Lista publica dos cenarios: so os campos que o aluno pode ver antes de iniciar o
// atendimento (card + contexto inicial) — nunca o perfil, a queixa do roteiro, o
// roteiro oculto, o diagnostico ou o checklist de avaliacao.
router.get("/cenarios", (_request: Request, response: Response) => {
  const cenariosPublicos = CENARIOS_OSCE.map(
    ({ id, titulo, especialidade, dificuldade, contextoInicial }) => ({
      id,
      titulo,
      especialidade,
      dificuldade,
      contextoInicial,
    }),
  );
  return response.status(200).json({ cenarios: cenariosPublicos });
});

// Uma fala do aluno no papel de medico — a IA responde em personagem como o paciente
// e identifica os exames pedidos; os resultados saem do cadastro do caso (US25).
router.post("/:id/mensagem", async (request: Request, response: Response, next: NextFunction) => {
  try {
    const cenario = obterCenarioOuFalhar(request.params.id);

    const corpo = schemaMensagem.safeParse(request.body);
    if (!corpo.success) {
      throw new ErroAplicacao({
        codigoStatus: 400,
        codigo: CodigoDeErro.REQUISICAO_INVALIDA,
        mensagem: MENSAGENS.mensagemOsceInvalida,
      });
    }

    if (!geminiClient) {
      throw new ErroAplicacao({
        codigoStatus: 503,
        codigo: CodigoDeErro.IA_INDISPONIVEL,
        mensagem: MENSAGENS.iaIndisponivel,
      });
    }

    const { data } = await geminiClient.post<RespostaGerarConteudo>(
      `/v1beta/models/${env.GEMINI_MODEL}:generateContent`,
      {
        system_instruction: { parts: [{ text: montarInstrucaoPaciente(cenario) }] },
        contents: historicoParaContents([
          ...corpo.data.historico,
          { autor: "aluno", texto: corpo.data.mensagem },
        ]),
        generationConfig: {
          ...GERACAO_THINKING_MINIMO,
          responseMimeType: "application/json",
          responseSchema: montarSchemaRespostaPaciente(cenario),
        },
      },
    );

    const bruto = data.candidates?.[0]?.content?.parts?.[0]?.text;
    const interpretacao = bruto ? schemaRespostaPaciente.safeParse(parseJsonOuNulo(bruto)) : null;
    // Fala e exames vem juntos: a IA identifica o que foi pedido e os resultados sao
    // copiados do cadastro do caso (montarTurnosResposta), nunca escritos pela IA.
    const turnos = interpretacao?.success ? montarTurnosResposta(cenario, interpretacao.data) : [];
    if (!turnos.length) {
      throw new ErroAplicacao({
        codigoStatus: 502,
        codigo: CodigoDeErro.ERRO_DOWNSTREAM,
        mensagem: MENSAGENS.respostaIaIndisponivel,
      });
    }

    // `resposta` continua sendo so a fala do paciente (contrato anterior); os cards de
    // exame vem em `turnos`, na ordem em que o aluno deve ve-los.
    const fala = turnos.find((turno) => turno.autor === "paciente")?.texto ?? "";
    return response.status(200).json({ resposta: fala, turnos });
  } catch (error) {
    return next(error);
  }
});

// Fim da simulacao: avalia o historico completo contra o checklist do cenario.
router.post("/:id/finalizar", async (request: Request, response: Response, next: NextFunction) => {
  try {
    const cenario = obterCenarioOuFalhar(request.params.id);

    const corpo = schemaFinalizar.safeParse(request.body);
    if (!corpo.success) {
      throw new ErroAplicacao({
        codigoStatus: 400,
        codigo: CodigoDeErro.REQUISICAO_INVALIDA,
        mensagem: MENSAGENS.historicoOsceInvalido,
      });
    }

    if (!geminiClient) {
      throw new ErroAplicacao({
        codigoStatus: 503,
        codigo: CodigoDeErro.IA_INDISPONIVEL,
        mensagem: MENSAGENS.iaIndisponivel,
      });
    }

    const transcricao = montarTranscricao(corpo.data.historico);

    const { data } = await geminiClient.post<RespostaGerarConteudo>(
      `/v1beta/models/${env.GEMINI_MODEL}:generateContent`,
      {
        system_instruction: { parts: [{ text: montarInstrucaoAvaliacao(cenario) }] },
        contents: [{ role: "user", parts: [{ text: transcricao || "(nenhuma pergunta feita)" }] }],
        generationConfig: {
          ...GERACAO_THINKING_MINIMO,
          responseMimeType: "application/json",
          responseSchema: montarSchemaAvaliacao(cenario),
        },
      },
    );

    const bruto = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!bruto) {
      throw new ErroAplicacao({
        codigoStatus: 502,
        codigo: CodigoDeErro.ERRO_DOWNSTREAM,
        mensagem: MENSAGENS.respostaIaIndisponivel,
      });
    }

    const avaliacaoIa = schemaAvaliacaoIa.safeParse(parseJsonOuNulo(bruto));
    if (!avaliacaoIa.success) {
      throw new ErroAplicacao({
        codigoStatus: 502,
        codigo: CodigoDeErro.ERRO_DOWNSTREAM,
        mensagem: MENSAGENS.avaliacaoOsceInvalida,
      });
    }

    // A nota sai daqui, nao da IA: ela so julgou os itens e deu a nota global.
    const resultado = pontuarRubrica(cenario, avaliacaoIa.data);

    return response.status(200).json({
      avaliacao: {
        cenarioId: cenario.id,
        titulo: cenario.titulo,
        diagnosticoEsperado: cenario.diagnosticoEsperado,
        comentarioFinal: avaliacaoIa.data.comentarioFinal,
        ...resultado,
      },
    });
  } catch (error) {
    return next(error);
  }
});

// Botao "melhorar com IA" de cada campo de texto do editor de caso OSCE: reescreve
// so o texto recebido, sem persistir nada (quem guarda o caso e o Quiz-Service).
router.post("/melhorar-texto", async (request: Request, response: Response, next: NextFunction) => {
  try {
    // So o professor edita casos OSCE; o aluno nunca chega a ver o editor.
    if (request.usuario?.papel !== "PROFESSOR") {
      throw new ErroAplicacao({
        codigoStatus: 403,
        codigo: CodigoDeErro.PROIBIDO,
        mensagem: MENSAGENS.acessoApenasProfessor,
      });
    }

    const corpo = schemaMelhorarTexto.safeParse(request.body);
    if (!corpo.success) {
      throw new ErroAplicacao({
        codigoStatus: 400,
        codigo: CodigoDeErro.REQUISICAO_INVALIDA,
        mensagem: MENSAGENS.textoOsceInvalido,
      });
    }

    if (!geminiClient) {
      throw new ErroAplicacao({
        codigoStatus: 503,
        codigo: CodigoDeErro.IA_INDISPONIVEL,
        mensagem: MENSAGENS.iaIndisponivel,
      });
    }

    const { data } = await geminiClient.post<RespostaGerarConteudo>(
      `/v1beta/models/${env.GEMINI_MODEL}:generateContent`,
      {
        system_instruction: {
          parts: [{ text: montarInstrucaoMelhorarTexto(corpo.data.campo, corpo.data.contexto) }],
        },
        contents: [{ role: "user", parts: [{ text: corpo.data.texto }] }],
        generationConfig: GERACAO_THINKING_MINIMO,
      },
    );

    const textoMelhorado = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!textoMelhorado) {
      throw new ErroAplicacao({
        codigoStatus: 502,
        codigo: CodigoDeErro.ERRO_DOWNSTREAM,
        mensagem: MENSAGENS.respostaIaIndisponivel,
      });
    }

    return response.status(200).json({ textoMelhorado });
  } catch (error) {
    return next(error);
  }
});

export { router as osceRouter };
