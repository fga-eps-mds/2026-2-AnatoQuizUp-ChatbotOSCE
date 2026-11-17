// Contratos genericos de resposta da API, compartilhados pelo servico inteiro.

// Envelope de erro: formato unico devolvido pelo middleware de tratamento de erros.
export type RespostaApiErro = {
  erro: {
    codigo: string;
    mensagem: string;
    detalhes?: unknown;
  };
};
