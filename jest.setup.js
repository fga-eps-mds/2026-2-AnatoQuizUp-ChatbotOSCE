process.env.NODE_ENV ||= "test";
process.env.PORT ||= "3335";
process.env.LOG_LEVEL ||= "silent";
// Vazia por padrao: osce.ia-indisponivel.test.ts depende do geminiClient ficar null.
// Sem isto, o .env local (usado pra rodar o stack) vazaria uma chave real pro teste.
process.env.GEMINI_API_KEY = "";
// Segredo fixo: os testes assinam tokens com ele, entao o CI nao pode sobrescreve-lo.
process.env.JWT_SECRET_KEY = "test-secret";
// Mesmo motivo: os testes enviam x-internal-token fixo, independente do .env local
// usado pra rodar o stack (que traz o segredo real compartilhado com o BFF).
process.env.INTERNAL_TOKEN = "test-internal-token";
// A suíte usa uma origem fixa, independente do ambiente que executa o Jest.
process.env.CORS_ORIGINS = "http://localhost:5173";
process.env.REQUEST_TIMEOUT_MS ||= "15000";
