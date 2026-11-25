import { criarOpcoesCors, parseCorsOrigins } from "@/config/cors";
import { ErroAplicacao } from "@/shared/errors/erro-aplicacao";

describe("config/cors", () => {
  test("parseCorsOrigins separa por virgula e remove vazios", () => {
    expect(parseCorsOrigins("a,b , c, ,d")).toEqual(["a", "b", "c", "d"]);
  });

  test("criarOpcoesCors permite origem incluida", () => {
    const opcoes = criarOpcoesCors(["http://app"]);
    const callback = jest.fn();
    (opcoes.origin as (origin: string | undefined, cb: jest.Mock) => void)(
      "http://app",
      callback,
    );
    expect(callback).toHaveBeenCalledWith(null, true);
  });

  test("criarOpcoesCors permite ausencia de origem (server-to-server/health)", () => {
    const opcoes = criarOpcoesCors(["http://app"]);
    const callback = jest.fn();
    (opcoes.origin as (origin: string | undefined, cb: jest.Mock) => void)(undefined, callback);
    expect(callback).toHaveBeenCalledWith(null, true);
  });

  test("criarOpcoesCors rejeita origem nao listada", () => {
    const opcoes = criarOpcoesCors(["http://app"]);
    const callback = jest.fn();
    (opcoes.origin as (origin: string | undefined, cb: jest.Mock) => void)(
      "http://outro",
      callback,
    );
    expect(callback).toHaveBeenCalledTimes(1);
    const argumento = callback.mock.calls[0][0];
    expect(argumento).toBeInstanceOf(ErroAplicacao);
    expect((argumento as ErroAplicacao).codigoStatus).toBe(403);
  });
});
