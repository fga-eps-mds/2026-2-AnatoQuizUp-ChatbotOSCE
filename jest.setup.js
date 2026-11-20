process.env.NODE_ENV ||= "test";
process.env.PORT ||= "3335";
process.env.LOG_LEVEL ||= "silent";
// Segredo fixo: os testes assinam tokens com ele, entao o CI nao pode sobrescreve-lo.
process.env.JWT_SECRET_KEY = "test-secret";
// A suíte usa uma origem fixa, independente do ambiente que executa o Jest.
process.env.CORS_ORIGINS = "http://localhost:5173";
process.env.REQUEST_TIMEOUT_MS ||= "15000";
