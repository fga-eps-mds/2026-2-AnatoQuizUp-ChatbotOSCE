// Garante que a chamada veio do BFF, comparando o header x-internal-token. Mesmo
// padrao usado pelo Quiz-Service: o ChatbotOSCE e privado e so aceita trafico
// que passou pelo proxy do BFF.
import type { NextFunction, Request, Response } from "express";

import { env } from "@/config/env";
import { CodigoDeErro } from "@/shared/errors/codigos-de-erro";
import { ErroAplicacao } from "@/shared/errors/erro-aplicacao";
import { MENSAGENS } from "@/shared/constants/mensagens";

export function middlewareTokenInterno(request: Request, _response: Response, next: NextFunction) {
  const recebido = request.header("x-internal-token");

  if (!recebido || recebido !== env.INTERNAL_TOKEN) {
    return next(
      new ErroAplicacao({
        codigoStatus: 403,
        codigo: CodigoDeErro.PROIBIDO,
        mensagem: MENSAGENS.tokenInternoInvalido,
      }),
    );
  }

  next();
}
