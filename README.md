# 2026-2-AnatoQuizUp-ChatbotOSCE

Repositório destinado ao microserviço do chatbot OSCE: simulação do paciente via
Gemini e avaliação por rubrica das estações do OSCE. Serviço stateless — a
persistência de cenários/tentativas/avaliações é responsabilidade do
Quiz-Service.

## Como rodar

```bash
cp .env.example .env   # preencha GEMINI_API_KEY e JWT_SECRET_KEY
npm ci
npm run dev            # http://localhost:3335
```

Ou via `make`: `make setup` (copia `.env` + instala deps) e `make dev`.

## Como testar

```bash
npm test       # Jest, sem cobertura
npm run test:ci # Jest com cobertura (gate de 85%)
```

Ou `make test` / `make test-ci`.

## Variáveis de ambiente

Ver `.env.example`. Principais:

| Variável | Descrição |
| --- | --- |
| `PORT` | Porta HTTP do serviço (padrão `3335`). |
| `GEMINI_API_KEY` | Chave da Gemini API; vazia desliga as rotas de simulação (503). |
| `GEMINI_MODEL` | Modelo usado para interpretar o paciente e avaliar a estação. |
| `JWT_SECRET_KEY` | Mesmo segredo do Usuario-Service, propagado pelo BFF. |
| `CORS_ORIGINS` | Origens liberadas, separadas por vírgula. |

## Docker

```bash
docker compose up --build
```
