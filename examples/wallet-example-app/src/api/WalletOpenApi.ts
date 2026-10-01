import { OpenApi } from "effect/http-api";
import { makeWalletApi } from "../WalletApp.ts";

// The wallet API's OpenAPI document, as the text checked in at docs/api/wallet-openapi.json. Produced from the
// same HttpApi the server serves (commands, errors, reads), without starting anything.
export const walletOpenApiDocument = (): string => `${JSON.stringify(OpenApi.fromApi(makeWalletApi()), null, 2)}\n`;

export const walletOpenApiFile = new URL("../../../../docs/api/wallet-openapi.json", import.meta.url);
