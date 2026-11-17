// Mensagens fixas reutilizadas nas respostas do servico, centralizadas para manter
// o texto consistente e facilitar ajustes em um unico lugar.
export const MENSAGENS = {
  servicoEmExecucao: "Chatbot OSCE do AnatoQuizUp em execucao.",
  erroInterno: "Ocorreu um erro interno inesperado.",
  rotaNaoEncontrada: "A rota solicitada nao foi encontrada.",
  origemCorsNaoPermitida: "Origem nao permitida pelo CORS.",
  tokenAcessoAusente: "Token de acesso ausente.",
  tokenAcessoInvalido: "Token de acesso invalido ou expirado.",
  tokenInternoInvalido: "Token interno ausente ou invalido. Acesso permitido somente via BFF.",
  iaIndisponivel: "Servico de IA ainda nao foi habilitado nesta release.",
  respostaIaIndisponivel: "Nao foi possivel obter uma resposta da IA agora. Tente novamente.",
  falhaServicoDownstream: "Falha ao consultar o servico downstream.",
  cenarioOsceNaoEncontrado: "Cenario de simulacao OSCE nao encontrado.",
  mensagemOsceInvalida: "Mensagem invalida: informe um texto de 1 a 500 caracteres.",
  historicoOsceInvalido: "Historico invalido: cada item precisa de autor (aluno/paciente) e texto.",
  avaliacaoOsceInvalida: "A IA nao devolveu uma avaliacao. Tente finalizar novamente.",
} as const;
